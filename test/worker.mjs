// Pomocný proces pre test súbežného zápisu: node worker.mjs <db> <agent> <to> <n>
import { openDb } from "../dist/db.js";
import { Inbox } from "../dist/core.js";

const [, , dbPath, agent, to, n] = process.argv;
const p = new Inbox(openDb(dbPath), agent);
for (let i = 0; i < Number(n); i++) {
  const { thread_id } = p.send(to, `s${i}`, `body ${i}`);
  p.reply(thread_id, `dodatok ${i}`, "question");
  p.inbox();
}
