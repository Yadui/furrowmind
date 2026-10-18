// Emergency billing brake for the FurrowMind demo project.
// Triggered by a Cloud Billing budget notification on Pub/Sub. When actual cost
// reaches the budget amount, it unlinks billing from the project, which stops
// ALL paid services (the app goes offline). Based on Google's documented pattern:
// https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
const functions = require("@google-cloud/functions-framework");
const { CloudBillingClient } = require("@google-cloud/billing");

const PROJECT_ID = process.env.TARGET_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const PROJECT_NAME = `projects/${PROJECT_ID}`;
const billing = new CloudBillingClient();

functions.cloudEvent("stopBilling", async (cloudEvent) => {
  const raw = Buffer.from(cloudEvent.data.message.data, "base64").toString();
  const data = JSON.parse(raw);
  const cost = Number(data.costAmount), budget = Number(data.budgetAmount);
  console.log(`Budget notification: cost=${cost} budget=${budget} ${data.currencyCode || ""} dryRun=${!!data.dryRun}`);

  if (!(cost >= budget)) return console.log("Below budget. No action.");
  const [info] = await billing.getProjectBillingInfo({ name: PROJECT_NAME });
  if (!info.billingEnabled) return console.log("Billing already disabled.");
  if (data.dryRun) return console.log(`DRY RUN: would disable billing for ${PROJECT_NAME}.`);

  // Unlink the billing account: stops all paid usage for this project.
  await billing.updateProjectBillingInfo({ name: PROJECT_NAME, projectBillingInfo: { billingAccountName: "" } });
  console.log(`Billing disabled for ${PROJECT_NAME}.`);
});
