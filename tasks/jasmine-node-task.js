
'use strict';

module.exports = function jasmineNodeTask(grunt) {

  var istanbul = require('istanbul'),
    jasmine = require('jasmine-node'),
    merge = require('deepmerge'),
    path = require('path'),
    fileset = require('fileset'),
    fs = require('fs');

  var reportingDir,
    coverageVar = '$$cov_' + new Date().getTime() + '$$',
    fileSrc = ['**/*.js'],
    options,
    done,
    reports = [];

  var coverageCollect = function coverageCollect(covPattern, collector) {

    // The pattern should be relative to the directory in which the reports are written
    var coverageFiles = grunt.file.expand(path.resolve(reportingDir, covPattern));

    coverageFiles.forEach(function eachFiles(coverageFile) {
      var contents = fs.readFileSync(coverageFile, 'utf8');
      var fileCov = JSON.parse(contents);
      if (options.coverage.relativize) {
        var cwd = process.cwd();
        var newFileCov = {};
        for (var key in fileCov) {
          if (fileCov.hasOwnProperty(key)) {
            var item = fileCov[key];
            var filePath = item.path;
            var relPath = path.relative(cwd, filePath);
            item.path = relPath;
            newFileCov[relPath] = item;
          }
        }
        fileCov = newFileCov;
      }
      collector.add(fileCov);
    });
  };

  var coverageThresholdCheck = function coverageThresholdCheck(collector) {

    // http://gotwarlost.github.io/istanbul/public/apidocs/classes/ObjectUtils.html
    var objUtils = istanbul.utils;

    // Check against thresholds
    collector.files().forEach(function eachFiles(file) {
      var summary = objUtils.summarizeFileCoverage(
        collector.fileCoverageFor(file)
      );

      Object.keys(options.coverage.thresholds).forEach(function eachKeys(metric) {
        var threshold = options.coverage.thresholds[metric];
        var actual = summary[metric];
        if (!actual) {
          grunt.fail.warn('unrecognized metric: ' + metric);
        }
        if (actual.pct < threshold) {
          grunt.fail.warn('expected ' + metric + ' coverage to be at least ' + threshold +
          '% but was ' + actual.pct + '%' + '\n\tat (' + file + ')');
        }
      });
    });
  };

  var collectReports = function collectReports() {
    var reportFile = path.resolve(reportingDir, options.coverage.reportFile),
      collector = new istanbul.Collector(), // http://gotwarlost.github.io/istanbul/public/apidocs/classes/Collector.html
      cov = global[coverageVar];
    console.log('#1 global[coverageVar]:', global[coverageVar]);

    // important: there is no event loop at this point
    // everything that happens in this exit handler MUST be synchronous
    grunt.file.mkdir(reportingDir); // yes, do this again since some test runners could clean the dir initially created

    grunt.verbose.writeln('Writing coverage object [' + reportFile + ']');

    fs.writeFileSync(reportFile, JSON.stringify(cov), 'utf8');

    if (options.coverage.collect !== false) {
      options.coverage.collect.forEach(function eachCollect(covPattern) {
        coverageCollect(covPattern, collector);
      });
    }
    else {
      collector.add(cov);
    }

    grunt.verbose.writeln('Writing coverage reports at [' + reportingDir + ']');

    reports.forEach(function eachReport(report) {
      report.writeReport(collector, true);
    });

    coverageThresholdCheck(collector);
  };

  var exitHandler = function exitHandler() {
    console.log('#2 global[coverageVar]:', global[coverageVar]);

    if (typeof global[coverageVar] !== 'object' || Object.keys(global[coverageVar]).length === 0) {
      grunt.log.error('No coverage information was collected, exit without writing coverage information');
      return;
    }
    collectReports();
  };

  var istanbulMatcherRun = function istanbulMatcherRun(matchFn, includes, excludes) {

    console.log('#3 global[coverageVar]:', global[coverageVar]);

    var instrumenter = new istanbul.Instrumenter({coverageVariable: coverageVar}),
      transformer = instrumenter.instrumentSync.bind(instrumenter),
      hookOpts = {verbose: options.isVerbose};

    istanbul.hook.hookRequire(matchFn, transformer, hookOpts);

    // Hook context to ensure that all requireJS modules get instrumented.
    // Hooking require in isolation does not appear to be sufficient.
    istanbul.hook.hookRunInThisContext(matchFn, transformer, hookOpts);

    //important: there is no event loop at this point
    //everything that happens in this exit handler MUST be synchronous
    console.log('include-all-sources:', options.coverage['include-all-sources']);
    if (options.coverage['include-all-sources']) {

      var cov = global[coverageVar] || {};
      console.log('#4 global[coverageVar]:', global[coverageVar]);
      // Files that are not touched by code ran by the test runner is manually instrumented, to
      // illustrate the missing coverage.
      console.log('matchFn.files', matchFn.files);
      console.log('includes:', this.filesSrc);
      console.log('excludes:', excludes);
      fileset(this.filesSrc.join(' '), excludes.join(' '), {}, function fileSet(err, files) {
        console.log('fileset err:', err);
        console.log('fileset files:', files);
      });
      matchFn.files.forEach(function includeAllSources(file) {
        if (!cov[file]) {
          transformer(fs.readFileSync(file, 'utf-8'), file);

          // When instrumenting the code, istanbul will give each FunctionDeclaration a value of 1 in coverState.s,
          // presumably to compensate for function hoisting. We need to reset this, as the function was not hoisted,
          // as it was never loaded.
          Object.keys(instrumenter.coverState.s).forEach(function eachKey(key) {
            instrumenter.coverState.s[key] = 0;
          });

          cov[file] = instrumenter.coverState;
        }
      });
    }


    // initialize the global variable to stop mocha from complaining about leaks
    global[coverageVar] = {};
  };


  var runner = function runner() {

    if (options.captureExceptions) {
      // Grunt will kill the process when it handles an uncaughtException, so we need to
      // remove their handler to allow the test suite to continue.
      // A downside of this is that we ignore any other registered `ungaughtException`
      // handlers.
      process.removeAllListeners('uncaughtException');
      process.on('uncaughtException', function onUncaught(e) {
        grunt.log.error('Caught unhandled exception: ', e.toString());
        grunt.log.error(e.stack);
      });
    }

    if (options.useHelpers) {
      jasmine.loadHelpersInFolder(
        options.projectRoot,
        new RegExp('helpers?\\.(' + options.extensions + ')$', 'i')
      );
    }

    try {
      jasmine.executeSpecsInFolder(options);
    }
    catch (e) {
      if (options.forceExit) {
        process.exit(1);
      }
      else {
        done(1);
      }
      grunt.log.error('Failed to execute "jasmine.executeSpecsInFolder": ' + e.stack);
    }
  };

  var doCoverage = function doCoverage() {

    // set up require hooks to instrument files as they are required
    var Report = istanbul.Report;

    grunt.file.mkdir(reportingDir); // ensure we fail early if we cannot do this

    var reportClassNames = options.coverage.report;
    reportClassNames.forEach(function eachReport(reportClassName) {
      reports.push(Report.create(reportClassName, {dir: reportingDir}));
    });

    // TODO: Move to options.coverage.report list
    if (options.coverage.print !== 'none') {
      switch (options.coverage.print) {
        case 'detail':
          reports.push(Report.create('text'));
          break;
        case 'both':
          reports.push(Report.create('text'));
          reports.push(Report.create('text-summary'));
          break;
        default:
          reports.push(Report.create('text-summary'));
          break;
      }
    }

    var excludes = options.coverage.excludes || [];
    excludes.push('**/node_modules/**');

    console.log('#1 fileSrc:', fileSrc);
    // http://gotwarlost.github.io/istanbul/public/apidocs/classes/Istanbul.html#method_matcherFor
    istanbul.matcherFor({
      root: options.projectRoot,
      includes: fileSrc,
      excludes: excludes
    }, function matcherCallback(err, matchFn) {
      if (err) {
        grunt.fail.warn('istanbul.matcherFor failed.');
        grunt.fail.warn(err);
        return;
      }
      istanbulMatcherRun(matchFn, fileSrc, excludes);
      runner();
    });

  };

  grunt.registerMultiTask('jasmine_node', 'Runs jasmine-node with Istanbul code coverage', function registerGrunt() {

    // Default options. Once Grunt does recursive merge, use that, maybe 0.4.6
    options = merge({

      // Used only in this plugin, thus can be refactored out
      projectRoot: process.cwd(), // string
      useHelpers: false, // boolean
      forceExit: false, // boolean, exit on failure
      match: '.', // string, used in the beginning of regular expression
      matchAll: false, // boolean, if false, the specNameMatcher is used, true will just be ''
      specNameMatcher: 'spec', // string, filename expression
      extensions: 'js', // string, used in regular expressions after dot, inside (), thus | could be used
      captureExceptions: false, // boolean

      // Coverage options
      coverage: { // boolean|object
        reportFile: 'coverage.json',
        'include-all-sources': true, // boolean, if false, then only files with tests are used in coverage report
        print: 'summary', // none, summary, detail, both
        collect: [ // paths relative to 'reportDir'
          'coverage*.json'
        ], // coverage report file matching patters
        relativize: true,
        thresholds: {
          statements: 0,
          branches: 0,
          lines: 0,
          functions: 0
        },
        reportDir: 'coverage',
        excludes: []
      },

      // jasmine-node specific options
      specFolders: null, // array
      onComplete: null, // function
      isVerbose: true, // boolean, TODO: start using grunt.verbose
      showColors: false, // boolean
      teamcity: false, // boolean
      useRequireJs: false, // boolean
      regExpSpec: null, // RegExp written based on the other options
      gowl: false, // boolean, use jasmineEnv.addReporter(new jasmine.GrowlReporter());
      junitreport: {
        report: false, // boolean, create JUnit XML reports
        savePath: './reports/',
        useDotNotation: true,
        consolidate: true
      },
      includeStackTrace: false, // boolean
      growl: false // boolean

      // coffee: false, // boolean
    }, this.options());

    options.coverage.report = options.coverage.report || ['lcov'];

    console.log('#2 fileSrc:', fileSrc);
    console.log('#2 this.filesSrc:', this.filesSrc);
    fileSrc = this.filesSrc || fileSrc;
    console.log('#3 fileSrc:', fileSrc);
    console.log('*** this:', this);
    console.log('*** this.files[0].src:', this.files[0].src);
    console.log('*** this.files[0].orig:', this.files[0].orig);

    // Tell grunt this task is asynchronous.
    done = this.async();

    if (options.specFolders === null) {
      options.specFolders = [options.projectRoot];
    }

    // Default value in jasmine-node is 'new RegExp(".(js)$", "i")'
    if (options.regExpSpec === null) {
      options.regExpSpec = new RegExp(
        options.match + (options.matchAll ? '' :
        // '(' + options.specFolders.join('|').replace(/\//g, '\\/') + ')\\/' +
        options.specNameMatcher + '\\.') + '(' + options.extensions + ')$', 'i');
    }

    if (typeof options.onComplete !== 'function') {
      options.onComplete = function onComplete(runner) {
        var exitCode = 1;
        var failedCount = runner.results().failedCount;
        grunt.log.writeln('');
        if (failedCount === 0) {
          exitCode = 0;
          if (options.coverage !== false) {
            exitHandler();
          }
        }

        if (options.forceExit && exitCode === 1) {
          grunt.fail.warn(failedCount + ' test(s) failed.', exitCode);
        }
        done(exitCode === 0);
      };
    }

    if (options.coverage !== false) {
      reportingDir = path.resolve(process.cwd(), options.coverage.reportDir);
      doCoverage();
    }
    else {
      runner();
    }
  });
};
