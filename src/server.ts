import app from "./app.js";
import { reconcileExpiredSubscriptions } from "./service-availability.js";

const port = Number(process.env.PORT || 8000);

let checkingExpiry = false;
function checkExpiry() {
  if (checkingExpiry) return;
  checkingExpiry = true;
  void reconcileExpiredSubscriptions().catch(() => {
    console.error("Unable to reconcile expired vendor subscriptions.");
  }).finally(() => { checkingExpiry = false; });
}

app.listen(port, () => {
  console.log(`WedPlan API running at http://localhost:${port}`);
  checkExpiry();
  setInterval(checkExpiry, 60_000).unref();
});
