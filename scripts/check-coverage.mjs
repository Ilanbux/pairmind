import fs from "node:fs";
import path from "node:path";

const coverageFile = path.resolve("coverage/lcov.info");
const minimumFunctions = 100;
const minimumLines = 100;

if (!fs.existsSync(coverageFile)) {
  console.error(`coverage gate: missing file ${coverageFile}`);
  process.exit(1);
}

const lcov = fs.readFileSync(coverageFile, "utf8");
let totalFunctions = 0;
let hitFunctions = 0;
let totalLines = 0;
let hitLines = 0;

for (const line of lcov.split("\n")) {
  if (line.startsWith("FNF:")) {
    totalFunctions += Number(line.slice(4));
  } else if (line.startsWith("FNH:")) {
    hitFunctions += Number(line.slice(4));
  } else if (line.startsWith("DA:")) {
    const [, hits] = line.slice(3).split(",");
    totalLines += 1;
    if (Number(hits) > 0) {
      hitLines += 1;
    }
  }
}

const functionCoverage = totalFunctions === 0 ? 100 : (hitFunctions / totalFunctions) * 100;
const lineCoverage = totalLines === 0 ? 100 : (hitLines / totalLines) * 100;

if (functionCoverage < minimumFunctions || lineCoverage < minimumLines) {
  console.error(
    `coverage gate: failed (functions ${functionCoverage.toFixed(2)}%, lines ${lineCoverage.toFixed(2)}%)`,
  );
  process.exit(1);
}

console.log(
  `coverage gate: passed (functions ${functionCoverage.toFixed(2)}%, lines ${lineCoverage.toFixed(2)}%)`,
);
