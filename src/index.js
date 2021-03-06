const fs = require('fs');
const path = require('path');
const async = require('async');
const loaderUtils = require('loader-utils');
const level = require('level');
const levelTTL = require('level-ttl');
const xxhash = require('xxhash');
const pkgVersion = require('../package.json').version;

const defaultCacheDirectory = path.resolve('.cache-loader');
const ENV = process.env.NODE_ENV || 'development';
const DAY = 24 * 3600 * 1000;
let internalDB;

function getDB(cacheDirectory, defaultTTL = DAY * 30) {
  if (!internalDB) {
    internalDB = level(`${cacheDirectory}/data.db`);
    internalDB = levelTTL(internalDB, {
      // one day
      checkFrequency: DAY,
      defaultTTL,
    });
  }
  return internalDB;
}

function loader(...args) {
  const callback = this.async();
  const { data } = this;
  const dependencies = this.getDependencies().concat(this.loaders.map(l => l.path));
  const contextDependencies = this.getContextDependencies();
  const toDepDetails = (dep, mapCallback) => {
    fs.stat(dep, (err, stats) => {
      if (err) {
        mapCallback(err);
        return;
      }
      mapCallback(null, {
        path: dep,
        mtime: stats.mtime.getTime(),
      });
    });
  };
  async.parallel([
    cb => async.mapLimit(dependencies, 20, toDepDetails, cb),
    cb => async.mapLimit(contextDependencies, 20, toDepDetails, cb),
  ], (err, taskResults) => {
    if (err) {
      callback(null, ...args);
      return;
    }
    const [deps, contextDeps] = taskResults;
    const db = getDB(data.cacheDirectory, data.ttl);
    db.put(data.hash, JSON.stringify({
      remainingRequest: data.remainingRequest,
      cacheIdentifier: data.cacheIdentifier,
      dependencies: deps,
      contextDependencies: contextDeps,
      result: args,
    }), () => {
      // ignore errors here
      callback(null, ...args);
    });
  });
}

function pitch(remainingRequest, prevRequest, dataInput) {
  const loaderOptions = loaderUtils.getOptions(this) || {};
  const defaultOptions = {
    cacheDirectory: defaultCacheDirectory,
    cacheIdentifier: `cache-loader:${pkgVersion} ${ENV}`,
    ttl: DAY * 30,
  };
  const options = Object.assign({}, defaultOptions, loaderOptions);
  const { cacheIdentifier, cacheDirectory, ttl } = options;
  const data = dataInput;
  const callback = this.async();
  const hash = digest(`${cacheIdentifier}\n${remainingRequest}`);
  // const cacheFile = path.join(cacheDirectory, `${hash}.json`);
  data.remainingRequest = remainingRequest;
  data.cacheIdentifier = cacheIdentifier;
  data.cacheDirectory = cacheDirectory;
  data.ttl = ttl;
  data.hash = hash;
  const db = getDB(cacheDirectory, ttl);
  db.get(hash, (dbErr, content) => {
    if (dbErr) {
      callback();
      return;
    }
    data.fileExists = true;
    let cacheData;
    try {
      cacheData = JSON.parse(content);
    } catch (e) {
      callback();
      return;
    }
    if (cacheData.remainingRequest !== remainingRequest || cacheData.cacheIdentifier !== cacheIdentifier) {
      // in case of a hash conflict
      callback();
      return;
    }
    async.each(cacheData.dependencies.concat(cacheData.contextDependencies), (dep, eachCallback) => {
      fs.stat(dep.path, (statErr, stats) => {
        if (statErr) {
          eachCallback(statErr);
          return;
        }
        if (stats.mtime.getTime() !== dep.mtime) {
          eachCallback(true);
          return;
        }
        eachCallback();
      });
    }, (err) => {
      if (err) {
        callback();
        return;
      }
      cacheData.dependencies.forEach(dep => this.addDependency(dep.path));
      cacheData.contextDependencies.forEach(dep => this.addContextDependency(dep.path));
      callback(null, ...cacheData.result);
    });
  });
}

function digest(str) {
  return xxhash.hash(Buffer.from(str), 0xCAFEBABE);
}

export { loader as default, pitch };
