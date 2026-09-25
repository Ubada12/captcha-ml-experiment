/**
 * ============================================================
 * TEST RUNNER
 * ============================================================
 *
 * Runs every *.test.js file in this directory, each as its OWN
 * `node` child process — deliberately not `require()`d in-process
 * — because several of these tests mutate the shared config
 * singleton and monkey-patch other modules' exports (there's no
 * test framework/mocking library in this project's dependencies,
 * so that's the mocking technique used — see
 * taxpayer-cache-gateway.test.js's header comment). Running each
 * file in a fresh process means that kind of global mutation can
 * never bleed from one test file into another.
 *
 * Usage: node test/run-all.js   (also wired up as `npm test`)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const testDir = __dirname;

const testFiles = fs.readdirSync(testDir)
    .filter(name => name.endsWith(".test.js"))
    .sort();

if (testFiles.length === 0) {
    console.log("No *.test.js files found under test/.");
    process.exit(1);
}

let anyFailed = false;

for (const file of testFiles) {
    console.log(`\n\x1b[1m== ${file} ==\x1b[0m`);

    try {
        const output = execFileSync(process.execPath, [path.join(testDir, file)], {
            encoding: "utf8"
        });
        process.stdout.write(output);
    } catch (error) {
        anyFailed = true;
        // execFileSync throws on non-zero exit — stdout/stderr are
        // still on the error object, and we want to see them either way.
        if (error.stdout) { process.stdout.write(error.stdout); }
        if (error.stderr) { process.stderr.write(error.stderr); }
    }
}

console.log("");
console.log(anyFailed ? "\x1b[31mSome test files failed.\x1b[0m" : "\x1b[32mAll test files passed.\x1b[0m");
process.exitCode = anyFailed ? 1 : 0;
