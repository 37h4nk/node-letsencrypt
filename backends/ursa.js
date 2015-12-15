'use strict';

var PromiseA = require('bluebird');
var path = require('path');
var fs = PromiseA.promisifyAll(require('fs'));
var cutils = PromiseA.promisifyAll(require('../lib/crypto-utils-ursa'));
//var futils = require('letsencrypt-forge/lib/crypto-utils');
var requestAsync = PromiseA.promisify(require('request'));
var lef = PromiseA.promisifyAll(require('letsencrypt-forge'));
var knownUrls = ['new-authz', 'new-cert', 'new-reg', 'revoke-cert'];

var ipc = {}; // in-process cache

//function noop() {}
function getAcmeUrls(args) {
  var now = Date.now();

  // TODO check response header on request for cache time
  if ((now - ipc.acmeUrlsUpdatedAt) < 10 * 60 * 1000) {
    return PromiseA.resolve(ipc.acmeUrls);
  }

  return requestAsync({
    url: args.server
  }).then(function (resp) {
    var data = resp.body;

    if ('string' === typeof data) {
      try {
        data = JSON.parse(data);
      } catch(e) {
        return PromiseA.reject(e);
      }
    }

    if (4 !== Object.keys(data).length) {
      console.warn("This Let's Encrypt / ACME server has been updated with urls that this client doesn't understand");
      console.warn(data);
    }
    if (!knownUrls.every(function (url) {
      return data[url];
    })) {
      console.warn("This Let's Encrypt / ACME server is missing urls that this client may need.");
      console.warn(data);
    }

    ipc.acmeUrlsUpdatedAt = Date.now();
    ipc.acmeUrls = {
      newAuthz: data['new-authz']
    , newCert: data['new-cert']
    , newReg: data['new-reg']
    , revokeCert: data['revoke-cert']
    };

    return ipc.acmeUrls;
  });
}

function createAccount(args, handlers) {
  var mkdirpAsync = PromiseA.promisify(require('mkdirp'));
  var os = require("os");
  var localname = os.hostname();

  // TODO support ECDSA
  // arg.rsaBitLength args.rsaExponent
  return cutils.generateRsaKeypairAsync(args.rsaBitLength, args.rsaExponent).then(function (pems) {
    /* pems = { privateKeyPem, privateKeyJwk, publicKeyPem, publicKeyMd5 } */

    return lef.registerNewAccountAsync({
      email: args.email
    , newReg: args._acmeUrls.newReg
    , debug: args.debug || handlers.debug
    , agreeToTerms: function (tosUrl, agree) {
        // args.email = email; // already there
        args.tosUrl = tosUrl;
        handlers.agreeToTerms(args, agree);
      }
    , accountPrivateKeyPem: pems.privateKeyPem
    }).then(function (body) {
      if ('string' === typeof body) {
        try {
          body = JSON.parse(body);
        } catch(e) {
          // ignore
        }
      }

      return mkdirpAsync(args.accountDir, function () {

        var accountDir = path.join(args.accountsDir, pems.publicKeyMd5);
        var isoDate = new Date().toISOString();
        var accountMeta = {
          creation_host: localname
        , creation_dt: isoDate
        };

        // meta.json {"creation_host": "ns1.redirect-www.org", "creation_dt": "2015-12-11T04:14:38Z"}
        // private_key.json { "e", "d", "n", "q", "p", "kty", "qi", "dp", "dq" }
        // regr.json:
        /*
        { body:
        { contact: [ 'mailto:coolaj86@gmail.com' ],
         agreement: 'https://letsencrypt.org/documents/LE-SA-v1.0.1-July-27-2015.pdf',
         key: { e: 'AQAB', kty: 'RSA', n: '...' } },
          uri: 'https://acme-v01.api.letsencrypt.org/acme/reg/71272',
          new_authzr_uri: 'https://acme-v01.api.letsencrypt.org/acme/new-authz',
          terms_of_service: 'https://letsencrypt.org/documents/LE-SA-v1.0.1-July-27-2015.pdf' }
         */
        return PromiseA.all([
          fs.writeFileAsync(path.join(accountDir, 'meta.json'), JSON.stringify(accountMeta), 'utf8')
        , fs.writeFileAsync(path.join(accountDir, 'private_key.json'), JSON.stringify(pems.privateKeyJwk), 'utf8')
        , fs.writeFileAsync(path.join(accountDir, 'regr.json'), JSON.stringify({ body: body }), 'utf8')
        ]).then(function () {
          return pems;
        });
      });
    });
  });
}

function getAccount(accountId, args, handlers) {
  console.log(args.accountsDir, accountId);
  var accountDir = path.join(args.accountsDir, accountId);
  var files = {};
  var configs = ['meta.json', 'private_key.json', 'regr.json'];

  return PromiseA.all(configs.map(function (filename) {
    var keyname = filename.slice(0, -5);

    return fs.readFileAsync(path.join(accountDir, filename), 'utf8').then(function (text) {
      var data;

      try {
        data = JSON.parse(text);
      } catch(e) {
        files[keyname] = { error: e };
        return;
      }

      files[keyname] = data;
    }, function (err) {
      files[keyname] = { error: err };
    });
  })).then(function () {

    if (!Object.keys(files).every(function (key) {
      return !files[key].error;
    })) {
      console.warn("Account '" + accountId + "' was currupt. No big deal (I think?). Creating a new one...");
      return createAccount(args, handlers);
    }

    return cutils.parseAccountPrivateKeyAsync(files.private_key).then(function (keypair) {
      files.accountId = accountId;                  // md5sum(publicKeyPem)
      files.publicKeyMd5 = accountId;               // md5sum(publicKeyPem)
      files.publicKeyPem = keypair.publicKeyPem;    // ascii PEM: ----BEGIN...
      files.privateKeyPem = keypair.privateKeyPem;  // ascii PEM: ----BEGIN...
      files.privateKeyJson = keypair.private_key;   // json { n: ..., e: ..., iq: ..., etc }

      return files;
    });
  });
}

function getAccountByEmail(args) {
  // If we read 10,000 account directories looking for
  // just one email address, that could get crazy.
  // We should have a folder per email and list
  // each account as a file in the folder
  // TODO
  return PromiseA.resolve(null);
}

module.exports.create = function (defaults, handlers) {
  var LE = require('../');
  var pyconf = PromiseA.promisifyAll(require('pyconf'));

  defaults.server = defaults.server || LE.liveServer;

  var wrapped = {
    registerAsync: function (args) {
      args.server = args.server || defaults.server || LE.liveServer; // https://acme-v01.api.letsencrypt.org/directory
      var acmeHostname = require('url').parse(args.server).hostname;
      var configDir = args.configDir || defaults.configDir || LE.configDir;
      args.renewalDir = args.renewalDir || path.join(configDir, 'renewal', args.domains[0] + '.conf');
      args.accountsDir = args.accountsDir || path.join(configDir, 'accounts', acmeHostname, 'directory');

      return pyconf.readFileAsync(args.renewalDir).then(function (renewal) {
        return renewal.account;
      }, function (err) {
        if ("EENOENT" === err.code) {
          return getAccountByEmail(args, handlers);
        }

        return PromiseA.reject(err);
      }).then(function (accountId) {
        // Note: the ACME urls are always fetched fresh on purpose
        return getAcmeUrls(args).then(function (urls) {
          args._acmeUrls = urls;

          if (accountId) {
            return getAccount(accountId, args, handlers);
          } else {
            return createAccount(args, handlers);
          }
        });
      }).then(function (account) {
      /*
        , domains: Array.isArray(args.domains) || (args.domains||'').split(',')
        , webroot: args.webrootPath
        , accountPrivateKeyPem: obj.privateKeyPem
        , setChallenge: function (domain, key, value, done) {
            args.domains = [domain];
            handlers.setChallenge(args, key, value, done);
          }
        , removeChallenge: function (domain, key, done) {
            args.domains = [domain];
            handlers.removeChallenge(args, key, done);
          }
      */
        console.log(account);
        throw new Error("IMPLEMENTATION NOT COMPLETE");
      });
/*
      return fs.readdirAsync(accountsDir, function (nodes) {
        return PromiseA.all(nodes.map(function (node) {
          var reMd5 = /[a-f0-9]{32}/i;
          if (reMd5.test(node)) {
          }
        }));
      });
*/
    }
  , fetchAsync: function (args) {
      var hostname = args.domains[0];
      var crtpath = defaults.configDir + defaults.fullchainTpl.replace(/:hostname/, hostname);
      var privpath = defaults.configDir + defaults.privkeyTpl.replace(/:hostname/, hostname);

      return PromiseA.all([
        fs.readFileAsync(privpath, 'ascii')
      , fs.readFileAsync(crtpath, 'ascii')
        // stat the file, not the link
      , fs.statAsync(crtpath)
      ]).then(function (arr) {
        return {
          key: arr[0]  // privkey.pem
        , cert: arr[1] // fullchain.pem
          // TODO parse centificate for lifetime / expiresAt
        , issuedAt: arr[2].mtime.valueOf()
        };
      }, function () {
        return null;
      });
    }
  };

  return wrapped;
};
