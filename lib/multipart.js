function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  if (!match) fail("無法讀取上載內容。");
  const boundary = match[1] || match[2];
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const opening = Buffer.from(`--${boundary}`);
  let cursor = 0;
  if (buffer.subarray(0, opening.length).equals(opening)) {
    cursor = opening.length;
  } else {
    const found = buffer.indexOf(delimiter);
    if (found < 0) fail("無法讀取上載內容。");
    cursor = found + delimiter.length;
  }

  const parts = [];
  while (cursor < buffer.length) {
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
    const next = buffer.indexOf(delimiter, cursor);
    if (next < 0) break;
    const chunk = buffer.subarray(cursor, next);
    const headerEnd = chunk.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const headerText = chunk.subarray(0, headerEnd).toString("utf8");
      const name = /name="([^"]*)"/.exec(headerText);
      const filename = /filename="([^"]*)"/.exec(headerText);
      const type = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      parts.push({
        name: name ? name[1] : "",
        filename: filename ? filename[1] : "",
        contentType: type ? type[1].trim() : "",
        data: chunk.subarray(headerEnd + 4),
      });
    }
    cursor = next + delimiter.length;
  }
  return parts;
}

function fail(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.payload = { error: message };
  throw error;
}

module.exports = { parseMultipart };
