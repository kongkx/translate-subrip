const fs = require('fs');
const path = require('path');
const commandLineArgs = require('command-line-args');
const iconv = require('iconv-lite');
const srtParser = require('subtitles-parser');
const googleTranslate = require('google-translate');
const groupBy = require('lodash.groupby');

const GOOGLE_API_KEY = 'AIzaSyAaG50S0UVUNmz8Asj7OmxGkDdjVozNxLY';

const googleTranslateInstance = googleTranslate(GOOGLE_API_KEY);

const optionDefinitions = [{
    name: 'encode',
    type: String
  },
  {
    name: 'file',
    type: String
  },
  {
    name: 'dir',
    type: String
  },
  {
    name: 'lang',
    type: String
  },
];

const defaultOptions = {
  lang: 'zh-CN',
};

const options = {
  ...defaultOptions,
  ...commandLineArgs(optionDefinitions),
};

// Translate File
if (options.file) {
  const inputPath = path.resolve(options.file);
  translateSubRip(inputPath, options);
  return;
}

// Translate Directory
const dirPath = path.resolve(options.dir);
let shouldPause = true;
let pauseTimer;

walk(dirPath, (err, files) => {
  if (err) {
    console.log(err);
    return;
  }
  const sourceSrts = files.filter((path) => (
    /\.srt$/.test(path) &&
    !(new RegExp(`\\[${options.lang}\\]`).test(path))
  ));

  let timer = setInterval(function () {
    if (shouldPause) {
      return;
    }
    if (sourceSrts.length === 0) {
      clearInterval(timer);
    }
    const collection = sourceSrts.splice(0, 3);
    collection.forEach((path) => {
      translateSubRip(path, options);
    })
  }, 5000);
})

/**
 * 翻译字幕文件
 * 
 * @param {String} inputPath 
 * @param {Object} options 
 */
function translateSubRip(inputPath, options) {
  fs.readFile(inputPath, function (err, buffer) {
    const rawStr = iconv.decode(buffer, options.encode);
    const rawData = srtParser.fromSrt(rawStr);
    const initData = cleanData(rawData);
    const info = getSentenceInfo(initData);
    // console.log(info);
    const groups = groupBy(info, (item) => item.no);
    const promises = [];

    Object.keys(groups).forEach((no) => {
      promises.push(translateSentenceGroup(groups[no]))
    })

    Promise.all(promises).then(
      (array) => {
        const records = array.reduce((a, b) => (
          [
            ...a,
            ...b
          ]
        ), []);
        const groupeById = groupBy(records, record => record.id);
        initData.forEach((script) => {
          const scriptTranslation = groupeById[script.id].map((item) => item.translate).join('');
          script.text += `\n${scriptTranslation}`
        });

        const pathCompos = /(.*)?\.srt$/.exec(inputPath);
        const outputPath = `${pathCompos[1]}[${options.lang}].srt`;
        fs.writeFile(outputPath, srtParser.toSrt(initData), (err) => {
          if (err) throw err;
          console.log('Saved: ', outputPath);
        });
      },
      (err) => {
        // Try Again 
        console.log(inputPath, err);
        if (err.response && err.response.statusCode === 403) {
          shouldPause = true;
          clearTimeout(pauseTimer);
          pauseTimer = setTimeout(() => {
            translateSubRip(inputPath, options);
            shouldPause = false;
          }, 1000 * 60)
        }
      }
    );
  });
}

/**
 * 翻译语句，并分割翻译
 * 
 * @param {Array} group 
 */
function translateSentenceGroup(group) {
  const text = (group.map((item) => item.text).join(' '));
  const textLength = text.length;
  return translate(text).then(
    (translation) => {
      const {
        translatedText
      } = translation;
      const translatedLength = translatedText.length;
      let startIndex = 0;
      const output = [];
      group.forEach((record) => {
        const recordLength = record.text.length;
        const interpolatedLength = Math.ceil(recordLength / textLength * translatedLength);
        record.translate = translatedText.slice(startIndex, startIndex + interpolatedLength);
        startIndex += interpolatedLength;
        output.push(record);
      });
      return output
    }
  );
}

/**
 * Google Translation Promise
 * 
 * @param {String} text 
 */
function translate(text) {
  return new Promise((resolve, reject) => {
    googleTranslateInstance.translate(text, 'zh-CN', function (err, translation) {
      if (err) {
        reject(err);
        return;
      }
      resolve(translation);
    });
  })
}

/**
 * 移除原字幕中的注释文本
 * 
 * @param {Array} srtData 
 */
function cleanData(srtData) {
  return srtData.map((item) => ({
    ...item,
    text: removeNotes(item.text)
  }))
}

/**
 * 移除原字幕中的注释文本
 * 
 * @param {String} text 
 */
function removeNotes(text) {
  const lines = text.split('\n');
  return lines.filter((line) => line.indexOf('----') === -1).join('\n')
}

/**
 * 获取每行字幕中的语句信息
 * - startIndex
 * - endIndex
 * - text
 * - id
 * - no // sentence number
 * 
 * @param {Array} srtData subrip parsed data
 * 
 * @returns {Array}
 */
function getSentenceInfo(srtData) {
  let sentenceCount = 0;
  const sentenceInfo = [];
  srtData.forEach((item) => {
    const sentenceRegex = /[.!?。！？]/g;
    const itemText = item.text;
    let lastIndex = 0;
    while (true) {
      const result = sentenceRegex.exec(itemText);
      if (!result) {
        if (lastIndex < itemText.length - 1) {
          sentenceInfo.push({
            id: item.id,
            no: sentenceCount,
            start: lastIndex,
            end: itemText.length - 1,
            text: itemText.slice(lastIndex)
          })
        }
        break;
      } else {
        sentenceInfo.push({
          id: item.id,
          no: sentenceCount,
          start: lastIndex,
          end: result.index + 1,
          text: itemText.slice(lastIndex, result.index + 1)
        })
        lastIndex = result.index + 1;
        sentenceCount = sentenceCount + 1;
      }
    }
  });
  return sentenceInfo;
}

/**
 * 遍历目录，获取文件列表
 * 
 * @param {String} dir 
 * @param {Function} done 
 */
function walk(dir, done) {
  var results = [];
  fs.readdir(dir, function (err, list) {
    if (err) return done(err);
    var pending = list.length;
    if (!pending) return done(null, results);
    list.forEach(function (file) {
      file = path.resolve(dir, file);
      fs.stat(file, function (err, stat) {
        if (stat && stat.isDirectory()) {
          walk(file, function (err, res) {
            results = results.concat(res);
            if (!--pending) done(null, results);
          });
        } else {
          results.push(file);
          if (!--pending) done(null, results);
        }
      });
    });
  });
};
