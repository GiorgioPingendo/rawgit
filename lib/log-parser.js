/**
Tails an upstream log file in Common or Combined Log Format and updates internal
request stats in real time based on logged requests.
**/

"use strict";

const fs    = require('fs');
const spawn = require('child_process').spawn;

const config = require('../conf');
const stats  = require('./stats');

/**
Matches a line in a Common or Combined Log Format log file.

Captured subpatterns:

1.  ip
2.  date
3.  method
4.  url
5.  status
6.  bytes
7.  referrer (optional)
8.  useragent (optional)

@type RegExp
**/
const REGEX_CLF = /^(\S+) \S+ \S+ \[(.+?)\] "(\S+) (\S+) \S+" (\S+) (\S+)(?: "([^"]*)" "([^"]*)")?$/;

/**
Matches the colon between the date and the time in a CLF datestamp. Used to
replace that damn colon with a space so we can parse the date.

@type RegExp
**/
const REGEX_DATE = /(\/\d+):(\d+)/;

/**
Matches an external (GitHub) request path. Used to avoid logging stats for
RawGit pages and assets.

@type RegExp
**/
const REGEX_EXTERNAL = /^\/.+?\/.+?\/.+?\/.+/;

/**
Matches a URL that should be considered a loopback URL and exempted from
referrer-based naughtiness calculations. Supports both IPv4 and IPv6 loopback
addresses.

@type RegExp
**/
const REGEX_LOOOPBACK_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[(?:(?:0+:){7}|::)0*1(?:\/128)?\])(?::\d+)?\//i;

/**
Matches everything from the beginning of a URL's query string to the end of the
string. Used to strip query strings out of URLs.

@type RegExp
**/
const REGEX_QUERY = /\?.*$/;

/**
Matches the beginning of a rawgit(hub).com URL.

@type RegExp
**/
const REGEX_RAWGIT = /^https?:\/\/rawgit(?:hub)?\.com\//i;

// -- Public Properties --------------------------------------------------------

/**
Whether or not the log parser is enabled.

@type Boolean
**/
exports.enabled = init();

// -- Private Functions --------------------------------------------------------

/**
Initializes the log parser.

@return {Boolean}
  Whether or not log parsing is enabled.
**/
function init() {
  let logPath = config.upstreamRequestLog;

  if (!logPath || !fs.existsSync(logPath)) {
    return false;
  }

  tail(logPath);
  return true;
}

/**
Parses a single line from a CLF log file and updates file and referrer request
stats.

@param {String} line
  Line to parse.
**/
function parseLine(line) {
  let matches = line.match(REGEX_CLF);

  if (!matches) {
    return;
  }

  // Ignore 403 responses (these are typically abusers that have been blocked
  // at the Nginx level).
  if (matches[5] === '403') {
    return;
  }

  let path = matches[4].replace(REGEX_QUERY, '');

  // Ignore explicitly ignored paths and pages and assets hosted on this
  // server.
  if (config.statsIgnorePaths[path] || !REGEX_EXTERNAL.test(path)) {
    return;
  }

  let referrer = matches[7].replace(REGEX_QUERY, '');

  // Ignore localhost referrers.
  if (REGEX_LOOOPBACK_URL.test(referrer)) {
    return;
  }

  // Ignore non-proxied rawgit referrers.
  if (REGEX_RAWGIT.test(referrer) && !REGEX_EXTERNAL.test(referrer)) {
    return;
  }

  let size = parseInt(matches[6], 10) || 0;
  let time = Date.parse(matches[2].replace(REGEX_DATE, '$1 $2')) || 0;

  stats.logRequest(path, referrer, size, time);
}

/**
Tails the log file at _logPath_ and parses new lines as they're added.

@param {String} logPath
  Path to a CLF log file.

@param {Boolean} [respawn=false]
  Whether this is a respawn (meaning scrollback should be ignored).
**/
function tail(logPath, respawn) {
  let scrollBack  = respawn ? 0 : config.upstreamRequestLogScrollback || 0;
  let tailProcess = spawn('tail', ['-F', '-n', scrollBack, logPath]);
  let tailStream  = tailProcess.stdout;

  tailProcess.on('error', () => {
    console.error('Error tailing ' + logPath);
    exports.enabled = false;
  });

  tailProcess.on('exit', () => {
    console.error('Tail process exited. Respawning.');
    tailStream.removeAllListeners();
    tail(logPath, true);
  });

  tailStream.setEncoding('utf8');

  let overflow = '';

  tailStream.on('readable', () => {
    let chunk = tailStream.read();
    let lines = (overflow + chunk).split("\n");

    overflow = lines.pop();

    for (let i = 0, len = lines.length; i < len; ++i) {
      parseLine(lines[i]);
    }
  });
}
