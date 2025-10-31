import dotenv from "dotenv"
dotenv.config()

import { EventMonitor } from "./event-monitor";

async function main() {
  const monitor = new EventMonitor();
  await monitor.start();
}

main().catch(err => {
  console.error('Fatal error in monitor:', err);
  process.exit(1);
});