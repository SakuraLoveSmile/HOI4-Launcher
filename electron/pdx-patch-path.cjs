"use strict";

const invalid = () =>
  Object.assign(new Error("模组下载清单格式不受支持。"), {
    code: "INVALID_MANIFEST",
  });
function normalizePdxPatchPath(value, { directory = false } = {}) {
  if (
    typeof value !== "string" ||
    !value ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    /[\0-\x1f\x7f<>:"|?*\ufffd]/.test(value)
  )
    throw invalid();
  let result = value.replaceAll("\\", "/");
  if (directory && result.endsWith("/")) result = result.slice(0, -1);
  const parts = result.split("/");
  if (
    parts.length > 64 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part, "utf8") > 255 ||
        /[. ]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)$/i.test(
          part.split(".")[0].replace(/ +$/, ""),
        ),
    )
  )
    throw invalid();
  return result;
}
// Uppercasing also folds final sigma and long s, which lowercasing misses.
// This is deliberately conservative for Windows destination name collisions.
const pdxPatchPathKey = (value) =>
  value.normalize("NFC").toUpperCase().normalize("NFC");
module.exports = { normalizePdxPatchPath, pdxPatchPathKey };
