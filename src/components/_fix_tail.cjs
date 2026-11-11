// Починка структуры JSX в конец NowPlaying: закрываем недостающие контейнеры
// и убираем лишние. Работаем по индексам, проверяя найденные строки.
const fs = require("fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split("\n");

const findFrom = (needle, start) => {
  for (let i = start; i < lines.length; i++) if (lines[i].includes(needle)) return i;
  return -1;
};

// Якорь: закрытие панели текста
const aside = findFrom("</motion.aside>", 1200);
if (aside < 0) {
  console.error("не нашёл закрытие панели текста");
  process.exit(1);
}
const tail = lines.slice(aside + 1);
console.log("после закрытия панели:", tail.slice(0, 12).map((l, i) => `${aside + 2 + i}: ${l}`).join("\n"));

const closing = [
  "              </div>",
  "            </div>",
  "          </div>",
  "        </motion.div>",
  "      )}",
  "    </>",
  "  );",
  "}",
];

const kept = lines.slice(0, aside + 1).concat(closing);
fs.writeFileSync(path, kept.join("\n") + "\n", "utf8");
console.log("пересобрано, строк:", kept.length);
