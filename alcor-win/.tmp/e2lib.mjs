import fs from "fs";
export function sub(p, a, b) { let s = fs.readFileSync(p, "utf8"); const crlf = s.includes("\r\n"); if (crlf) s = s.replace(/\r\n/g, "\n"); if (!s.includes(a)) throw new Error("missing in " + p + ": " + a.slice(0,50)); s = s.replace(a, () => b); if (crlf) s = s.replace(/\n/g, "\r\n"); fs.writeFileSync(p, s); }
