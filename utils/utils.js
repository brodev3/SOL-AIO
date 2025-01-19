const fs = require('fs');
const crypto = require('crypto');
const csv = require('csv-parser');
const path = require("path")
const config = require('../config/config');

const secretKey = crypto.createHash('sha256').update(config.MESSAGE).digest();
const inputFilePath = path.resolve(__dirname, '..') + '/input/';

function decrypt(text, secretKey) {
  const [iv, encrypted] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', secretKey, Buffer.from(iv, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

async function readDecryptCSVToArray() {
  return new Promise((resolve, reject) => {
    const decryptedRows = [];

    fs.createReadStream(inputFilePath + "w.csv")
      .pipe(csv())
      .on('data', (row) => {
        const decryptedRow = {};

        for (let key in row) 
          decryptedRow[key] = decrypt(row[key], secretKey);
        
        decryptedRows.push(decryptedRow);
      })
      .on('end', () => {
        console.log('File decrypted success.');
        const result = decryptedRows.map(row => {
          return Object.values(row).join(','); 
        });
        resolve(result);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
};

async function readCSVToArray(path) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(inputFilePath + path)
      .pipe(csv())
      .on('data', (row) => {
        rows.push(row);
      })
      .on('end', () => {
        console.log('File reading success.');
        const result = rows.map(row => {
          return Object.values(row).join(','); 
        });
        resolve(result);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
};

module.exports = {
  readCSVToArray,
  readDecryptCSVToArray
};
