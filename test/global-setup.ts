import { execSync } from "node:child_process";

// Testy súbežného zápisu spúšťajú skutočné procesy z dist/.
export default function setup() {
  execSync("npx tsc", { stdio: "inherit" });
}
