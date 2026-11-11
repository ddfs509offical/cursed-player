// Замена функции fetch в lyrics.rs: от строки с сигнатурой до закрывающей "}".
const fs = require("fs");

const file = process.argv[2];
const blockFile = process.argv[3];
const startMarker = process.argv[4] || "pub fn fetch(";

const raw = fs.readFileSync(file, "utf8");
const lines = raw.split("\n");
const block = fs.readFileSync(blockFile, "utf8").replace(/\r/g, "").replace(/\n$/, "").split("\n");

let start = lines.findIndex((line) => line.trimStart().startsWith(startMarker));
if (start < 0) {
  console.error("нет стартовой строки");
  process.exit(1);
}
while (start > 0 && lines[start - 1].trimStart().startsWith("///")) start -= 1;

let end = start;
while (end < lines.length && lines[end].trim() !== "}") end += 1;
if (end >= lines.length) {
  console.error("не нашёл конец функции");
  process.exit(1);
}

const out = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
fs.writeFileSync(file, out.join("\n"), "utf8");
console.log(`заменено строк ${start + 1}..${end + 1}`);
