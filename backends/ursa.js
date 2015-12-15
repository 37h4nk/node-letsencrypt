'use strict';

var PromiseA = require('bluebird');
var path = require('path');
var fs = PromiseA.promisifyAll(require('fs'));
var requestAsync = PromiseA.promisify(require('request'));

var LE = require('../');
var knownUrls = ['new-authz', 'new-cert', 'new-reg', 'revoke-cert'];
var ucrypto = PromiseA.promisifyAll(require('../lib/crypto-utils-ursa'));
//var fcrypto = PromiseA.promisifyAll(require('../lib/crypto-utils-forge'));
var lef = PromiseA.promisifyAll(require('letsencrypt-forge'));
var fetchFromConfigLiveDir = require('./common').fetchFromDisk;

var ipc = {}; // in-process cache

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
  return ucrypto.generateRsaKeypairAsync(args.rsaBitLength, args.rsaExponent).then(function (pems) {
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
      if (body instanceof Buffer) {
        body = body.toString('utf8');
      }
      if ('string' === typeof body) {
        try {
          body = JSON.parse(body);
        } catch(e) {
          // ignore
        }
      }

      var accountDir = path.join(args.accountsDir, pems.publicKeyMd5);

      return mkdirpAsync(accountDir).then(function () {

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

    return ucrypto.parseAccountPrivateKeyAsync(files.private_key).then(function (keypair) {
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

function getCertificateAsync(account, args, defaults, handlers) {
  var pyconf = PromiseA.promisifyAll(require('pyconf'));

  return ucrypto.generateRsaKeypairAsync(args.rsaBitLength, args.rsaExponent).then(function (domain) {
    return lef.getCertificateAsync({
      domains: args.domains
    , accountPrivateKeyPem: account.privateKeyPem
    , domainPrivateKeyPem: domain.privateKeyPem
    , setChallenge: function (domain, key, value, done) {
        args.domains = [domain];
        args.webrootPath = args.webrootPath || defaults.webrootPath;
        handlers.setChallenge(args, key, value, done);
      }
    , removeChallenge: function (domain, key, done) {
        args.domains = [domain];
        args.webrootPath = args.webrootPath || defaults.webrootPath;
        handlers.removeChallenge(args, key, done);
      }
    , newAuthorizationUrl: args._acmeUrls.newAuthz
    , newCertificateUrl: args._acmeUrls.newCert
    }).then(function (result) {
      console.log(result);
      throw new Error("IMPLEMENTATION NOT COMPLETE");
    });
  });
}

function registerWithAcme(args, defaults, handlers) {
  var pyconf = PromiseA.promisifyAll(require('pyconf'));
  var server = args.server || defaults.server || LE.liveServer; // https://acme-v01.api.letsencrypt.org/directory
  var acmeHostname = require('url').parse(server).hostname;
  var configDir = args.configDir || defaults.configDir || LE.configDir;

  args.server = server;
  args.renewalDir = args.renewalDir || path.join(configDir, 'renewal', args.domains[0] + '.conf');
  args.accountsDir = args.accountsDir || path.join(configDir, 'accounts', acmeHostname, 'directory');

  return pyconf.readFileAsync(args.renewalDir).then(function (renewal) {
    var accountId = renewal.account;
    renewal = renewal.account;

    return accountId;
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
    if (renewal.account !== account) {
      // the account has become corrupt, re-register
      return;
    }
    */

    console.log(account);
    return fetchFromConfigLiveDir(args, defaults).then(function (certs) {
      // if nothing, register and save
      // if something, check date (don't register unless 30+ days)
      // if good, don't bother registering
      // (but if we get to the point that we're actually calling
      // this function, that shouldn't be the case, right?)
      console.log(certs);
      if (!certs) {
        // no certs, seems like a good time to get some
        return getCertificateAsync(account, args, defaults, handlers);
      }
      else if (certs.issuedAt > (27 * 24 * 60 * 60 * 1000)) {
        // cert is at least 27 days old we can renew that
        return getCertificateAsync(account, args, defaults, handlers);
      }
      else if (args.force) {
        // YOLO! I be gettin' fresh certs 'erday! Yo!
        return getCertificateAsync(account, args, defaults, handlers);
      }
      else {
        console.warn('[WARN] Ignoring renewal attempt for certificate less than 27 days old. Use args.force to force.');
        // We're happy with what we have
        return certs;
      }
    });

    /*
    cert = /home/aj/node-letsencrypt/tests/letsencrypt.config/live/lds.io/cert.pem
    privkey = /home/aj/node-letsencrypt/tests/letsencrypt.config/live/lds.io/privkey.pem
    chain = /home/aj/node-letsencrypt/tests/letsencrypt.config/live/lds.io/chain.pem
    fullchain = /home/aj/node-letsencrypt/tests/letsencrypt.config/live/lds.io/fullchain.pem

    # Options and defaults used in the renewal process
    [renewalparams]
    apache_enmod = a2enmod
    no_verify_ssl = False
    ifaces = None
    apache_dismod = a2dismod
    register_unsafely_without_email = False
    uir = None
    installer = none
    config_dir = /home/aj/node-letsencrypt/tests/letsencrypt.config
    text_mode = True
    func = <function obtain_cert at 0x7f46af0f02a8>
    prepare = False
    work_dir = /home/aj/node-letsencrypt/tests/letsencrypt.work
    tos = True
    init = False
    http01_port = 80
    duplicate = False
    key_path = None
    nginx = False
    fullchain_path = /home/aj/node-letsencrypt/chain.pem
    email = coolaj86@gmail.com
    csr = None
    agree_dev_preview = None
    redirect = None
    verbose_count = -3
    config_file = None
    renew_by_default = True
    hsts = False
    authenticator = webroot
    domains = lds.io,
    rsa_key_size = 2048
    checkpoints = 1
    manual_test_mode = False
    apache = False
    cert_path = /home/aj/node-letsencrypt/cert.pem
    webroot_path = /home/aj/node-letsencrypt/examples/../tests/acme-challenge,
    strict_permissions = False
    apache_server_root = /etc/apache2
    account = 1c41c64dfaf10d511db8aef0cc33b27f
    manual_public_ip_logging_ok = False
    chain_path = /home/aj/node-letsencrypt/chain.pem
    standalone = False
    manual = False
    server = https://acme-staging.api.letsencrypt.org/directory
    standalone_supported_challenges = "http-01,tls-sni-01"
    webroot = True
    apache_init_script = None
    user_agent = None
    apache_ctl = apache2ctl
    apache_le_vhost_ext = -le-ssl.conf
    debug = False
    tls_sni_01_port = 443
    logs_dir = /home/aj/node-letsencrypt/tests/letsencrypt.logs
    configurator = None
    [[webroot_map]]
    lds.io = /home/aj/node-letsencrypt/examples/../tests/acme-challenge
    */
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

module.exports.create = function (defaults, handlers) {
  defaults.server = defaults.server || LE.liveServer;

  var wrapped = {
    registerAsync: function (args) {
      //require('./common').registerWithAcme(args, defaults, handlers);
      return registerWithAcme(args, defaults, handlers);
    }
  , fetchAsync: function (args) {
      return fetchFromConfigLiveDir(args, defaults);
    }
  };

  return wrapped;
};
