// Multi-Domain & Multi-Intent Evaluation Suite for Vakyartha
// Verifies dynamic discovery, cross-domain routing, and compound multi-intent turns across 8 distinct domains.

import assert from "node:assert/strict";
import { HeuristicDecisionProvider } from "../src/decision/heuristic.ts";
import { OllamaDecisionProvider, DEFAULT_OLLAMA_HOST } from "../src/decision/providers/ollama.ts";
import { OpenAIDecisionProvider } from "../src/decision/providers/openai.ts";
import { shapeTurn } from "../src/decision/shaper.ts";
import { getDecisionConfig } from "../src/decision/index.ts";
import type { ChatTurnPayload } from "../src/decision/shaper.ts";
import { execSync } from "node:child_process";

// 8 Distinct Non-Developer Enterprise & Human Domains
const MULTI_DOMAIN_CATALOG = [
  // 1. Healthcare & Life Sciences
  { name: "epic_ehr__get_patient_vitals", namespace: "epic_ehr", description: "Fetch EHR patient vitals, history, and medical observations" },
  { name: "pharmacy_rx__check_drug_interaction", namespace: "pharmacy_rx", description: "Verify pharmaceutical drug-to-drug contraindications" },
  { name: "lab_results__query", namespace: "lab_results", description: "Search clinical bloodwork and diagnostic laboratory tests" },

  // 2. Supply Chain & Freight Logistics
  { name: "freight_tracker__get_container_status", namespace: "freight_tracker", description: "Track maritime shipping container location and ETA" },
  { name: "warehouse_erp__query_pallet_stock", namespace: "warehouse_erp", description: "Inspect pallet inventory and bin allocations in warehouses" },
  { name: "customs_portal__file_declaration", namespace: "customs_portal", description: "Submit import duty declarations and clearance documentation" },

  // 3. Legal & Corporate Compliance
  { name: "contract_vault__search_clauses", namespace: "contract_vault", description: "Search enterprise contracts for indemnification and liability terms" },
  { name: "gdpr_audit__scan_pii", namespace: "gdpr_audit", description: "Scan user data stores for personally identifiable information" },
  { name: "sec_edgar__fetch_10k_filing", namespace: "sec_edgar", description: "Retrieve audited annual 10-K and 10-Q SEC corporate filings" },

  // 4. Sales & Customer Success (CRM)
  { name: "salesforce__get_opportunity", namespace: "salesforce", description: "Fetch pipeline opportunity details, stage, and deal size" },
  { name: "zendesk__get_ticket_history", namespace: "zendesk", description: "Review historical customer support tickets and NPS sentiment" },
  { name: "slack__send_channel_notification", namespace: "slack", description: "Post real-time notification alerts to Slack team channels" },

  // 5. FinTech & Corporate Treasury
  { name: "stripe_billing__get_overdue_invoices", namespace: "stripe_billing", description: "Query past-due recurring subscriptions and unpaid invoices" },
  { name: "duckdb__run_ledger_sql", namespace: "duckdb", description: "Execute analytical SQL against local financial ledgers" },
  { name: "binance_market__get_ticker", namespace: "binance_market", description: "Fetch real-time order books, trade volume, and crypto pairs" },

  // 6. Real Estate & Property Management
  { name: "property_mls__search_listings", namespace: "property_mls", description: "Search residential real estate MLS listings and comps" },
  { name: "tenant_lease__get_terms", namespace: "tenant_lease", description: "Review tenant lease terms, deposit receipts, and renewal dates" },
  { name: "maintenance_dispatch__create_ticket", namespace: "maintenance_dispatch", description: "Dispatch plumbing, HVAC, or electrical service technicians" },

  // 7. Academic Research & Higher Education
  { name: "arxiv_api__search_papers", namespace: "arxiv_api", description: "Search arXiv scientific preprints and abstracts" },
  { name: "crossref_citations__get_graph", namespace: "crossref_citations", description: "Build scientific citation graphs and peer review metadata" },
  { name: "canvas_lms__get_grades", namespace: "canvas_lms", description: "Access course syllabus, student gradebooks, and assignment rosters" },

  // 8. Cloud Infrastructure & DevOps
  { name: "k8s_cluster__get_pod_logs", namespace: "k8s_cluster", description: "Tail Kubernetes container logs and pod restart events" },
  { name: "pagerduty__trigger_incident", namespace: "pagerduty", description: "Trigger on-call incident alerts for operational outages" },
  { name: "github__create_pull_request", namespace: "github", description: "Open reviewed pull requests on GitHub repositories" },
];

interface EvalOutcome {
  testId: string;
  category: string;
  description: string;
  passed: boolean;
  notes: string;
}

const outcomes: EvalOutcome[] = [];

function check(testId: string, category: string, description: string, passed: boolean, notes: string) {
  outcomes.push({ testId, category, description, passed, notes });
  const icon = passed ? "✅ PASS" : "❌ FAIL";
  console.log(`${icon} [${category}] ${testId}: ${description}\n      -> ${notes}`);
}

async function runMultiDomainMultiIntentEval() {
  console.log("=========================================================================");
  console.log("   VAKYARTHA MULTI-DOMAIN & MULTI-INTENT EVALUATION SUITE               ");
  console.log(`   Catalog: 8 Domains, ${MULTI_DOMAIN_CATALOG.length} Runtime Discovered MCP Tools`);
  console.log("=========================================================================\n");

  const heuristic = new HeuristicDecisionProvider();
  const ollama = new OllamaDecisionProvider(DEFAULT_OLLAMA_HOST, "d1-omni:latest");

  let openAIKey: string | undefined;
  try {
    openAIKey = execSync("security find-generic-password -s com.nranjan2code.vakyartha -a OPENAI_API_KEY -w", { encoding: "utf8" }).trim();
  } catch {
    openAIKey = process.env.OPENAI_API_KEY;
  }
  const openai = new OpenAIDecisionProvider(openAIKey, "gpt-4o-mini");

  const baseConfig = {
    ...getDecisionConfig(),
    enabled: true,
    providerId: "heuristic" as const,
    stripSalutations: true,
    optimizeContext: true,
    pruneTools: true,
  };

  // -----------------------------------------------------------------------------------
  // TEST 1: Cross-Domain Tri-Compound Request (Healthcare + CRM + Team Notification)
  // -----------------------------------------------------------------------------------
  console.log("--- 1. Cross-Domain Tri-Compound Request (Healthcare + CRM + Slack) ---");
  const turn1: ChatTurnPayload = {
    message: "Look up patient 9042 vitals in Epic EHR, verify their insurance policy status in Salesforce, and post an urgent notification to the clinical team on Slack.",
    tools: MULTI_DOMAIN_CATALOG,
  };

  const shaped1 = await shapeTurn(turn1, baseConfig);
  const retained1 = shaped1.payload.tools?.map((t) => t.name) ?? [];
  const hasEpic = retained1.includes("epic_ehr__get_patient_vitals");
  const hasSalesforce = retained1.includes("salesforce__get_opportunity");
  const hasSlack = retained1.includes("slack__send_channel_notification");
  const prunedIrrelevant1 = !retained1.some((t) => t.startsWith("k8s_") || t.startsWith("freight_") || t.startsWith("property_"));

  check("MD-01", "MULTI-DOMAIN-TRI-COMPOUND", "Retains all 3 target domain tools & prunes 5 irrelevant domains",
    hasEpic && hasSalesforce && hasSlack && prunedIrrelevant1,
    `Retained: [${retained1.join(", ")}], Pruned count: ${shaped1.prunedToolCount}`);

  // -----------------------------------------------------------------------------------
  // TEST 2: FinTech & Logistics Dual-Compound (Stripe Invoices + Maritime Freight)
  // -----------------------------------------------------------------------------------
  console.log("\n--- 2. FinTech & Logistics Dual-Compound (Stripe Billing + Maritime Freight) ---");
  const turn2: ChatTurnPayload = {
    message: "Check overdue invoices in Stripe billing for customer Horizon, and track their shipping container status in the freight tracker.",
    tools: MULTI_DOMAIN_CATALOG,
  };

  const shaped2 = await shapeTurn(turn2, baseConfig);
  const retained2 = shaped2.payload.tools?.map((t) => t.name) ?? [];
  const hasStripe = retained2.includes("stripe_billing__get_overdue_invoices");
  const hasFreight = retained2.includes("freight_tracker__get_container_status");
  const prunedMedical = !retained2.some((t) => t.startsWith("epic_") || t.startsWith("pharmacy_"));

  check("MD-02", "FINTECH-LOGISTICS-COMPOUND", "Retains Stripe and Freight tools while pruning medical/cloud tools",
    hasStripe && hasFreight && prunedMedical,
    `Retained: [${retained2.join(", ")}], Pruned: ${shaped2.prunedToolCount}`);

  // -----------------------------------------------------------------------------------
  // TEST 3: Hybrid Visual Refinement + External Tool Fetch (Canvas Chart + Binance API)
  // Red/Blue Vulnerability Check: User refines active chart AND requests external data fetch
  // -----------------------------------------------------------------------------------
  console.log("\n--- 3. Hybrid Visual Canvas Refinement + External Tool Data Fetch ---");
  const turn3: ChatTurnPayload = {
    message: "Change the chart to a candlestick layout and fetch the latest trade ticker from Binance.",
    surfaces: [{ id: "crypto_portfolio", title: "Live Market", componentTypes: ["chart"] }],
    tools: MULTI_DOMAIN_CATALOG,
  };

  const shaped3 = await shapeTurn(turn3, baseConfig);
  const retained3 = shaped3.payload.tools?.map((t) => t.name) ?? [];
  // The system must recognize that external data fetch is required and NOT starve the Binance tool!
  const hasBinance = retained3.includes("binance_market__get_ticker");
  const hasSurfaceGrammar = shaped3.shape.includeSurfaceGrammar === true;

  check("MI-01", "HYBRID-CANVAS-DATA-FETCH", "Canvas refinement with data fetch retains external API tool and surface grammar",
    hasBinance && hasSurfaceGrammar,
    `Intent: ${shaped3.shape.intent}, Binance Tool Retained: ${hasBinance}, Surface Grammar: ${hasSurfaceGrammar}`);

  // -----------------------------------------------------------------------------------
  // TEST 4: Salutation Disguised Multi-Intent (Greeting + Property MLS Search + Lease)
  // -----------------------------------------------------------------------------------
  console.log("\n--- 4. Salutation Disguised Multi-Intent (Greeting + Real Estate MLS Search) ---");
  const turn4: ChatTurnPayload = {
    message: "Good morning! Could you search residential MLS listings in Seattle and review the standard lease terms?",
    tools: MULTI_DOMAIN_CATALOG,
  };

  const shaped4 = await shapeTurn(turn4, baseConfig);
  const retained4 = shaped4.payload.tools?.map((t) => t.name) ?? [];
  const isNotPureSalutation = shaped4.shape.intent !== "salutation";
  const hasMLS = retained4.includes("property_mls__search_listings");
  const hasLease = retained4.includes("tenant_lease__get_terms");

  check("MI-02", "GREETING-DISGUISED-PROPERTY-SEARCH", "Compound greeting + property search is not truncated to salutation",
    isNotPureSalutation && hasMLS && hasLease,
    `Intent: ${shaped4.shape.intent}, Retained: [${retained4.join(", ")}]`);

  // -----------------------------------------------------------------------------------
  // TEST 5: Academic Research Deep Reasoning + Citation Graph Tool
  // -----------------------------------------------------------------------------------
  console.log("\n--- 5. Academic Research Deep Reasoning + Citation Graph ---");
  const turn5: ChatTurnPayload = {
    message: "Conduct a comprehensive literature synthesis analyzing the transformer attention mechanisms, retrieve citations from CrossRef, and search arXiv preprints.",
    tools: MULTI_DOMAIN_CATALOG,
  };

  const shaped5 = await shapeTurn(turn5, baseConfig);
  const retained5 = shaped5.payload.tools?.map((t) => t.name) ?? [];
  const hasArxiv = retained5.includes("arxiv_api__search_papers");
  const hasCrossRef = retained5.includes("crossref_citations__get_graph");
  const hasReasoningBudget = (shaped5.payload.maxSteps ?? 0) >= 6;

  check("MD-03", "ACADEMIC-REASONING-CITATION", "Academic synthesis retains arXiv & CrossRef with deep step limits",
    hasArxiv && hasCrossRef && hasReasoningBudget,
    `Intent: ${shaped5.shape.intent}, Steps: ${shaped5.payload.maxSteps}, Retained: [${retained5.join(", ")}]`);

  // -----------------------------------------------------------------------------------
  // TEST 6: Legal Compliance Audit (GDPR PII Scan + SEC Edgar 10-K Filing)
  // -----------------------------------------------------------------------------------
  console.log("\n--- 6. Legal Compliance Audit (GDPR PII Scan + SEC Edgar 10-K) ---");
  const turn6: ChatTurnPayload = {
    message: "Perform a compliance audit: scan user records for GDPR PII exposure and retrieve our 10-K filing from the SEC portal.",
    tools: MULTI_DOMAIN_CATALOG,
  };

  const shaped6 = await shapeTurn(turn6, baseConfig);
  const retained6 = shaped6.payload.tools?.map((t) => t.name) ?? [];
  const hasGDPR = retained6.includes("gdpr_audit__scan_pii");
  const hasSEC = retained6.includes("sec_edgar__fetch_10k_filing");

  check("MD-04", "LEGAL-COMPLIANCE-AUDIT", "Legal audit routes to GDPR and SEC tools correctly",
    hasGDPR && hasSEC,
    `Retained: [${retained6.join(", ")}], Pruned: ${shaped6.prunedToolCount}`);

  // -----------------------------------------------------------------------------------
  // TEST 7: Cloud DevOps Outage Response (Kubernetes Pod Logs + PagerDuty Incident)
  // -----------------------------------------------------------------------------------
  console.log("\n--- 7. Cloud DevOps Outage Response (Kubernetes Logs + PagerDuty Incident) ---");
  const turn7: ChatTurnPayload = {
    message: "The payments service is crashing. Inspect Kubernetes pod logs and trigger a PagerDuty incident for the on-call engineer.",
    tools: MULTI_DOMAIN_CATALOG,
  };

  const shaped7 = await shapeTurn(turn7, baseConfig);
  const retained7 = shaped7.payload.tools?.map((t) => t.name) ?? [];
  const hasK8s = retained7.includes("k8s_cluster__get_pod_logs");
  const hasPagerDuty = retained7.includes("pagerduty__trigger_incident");

  check("MD-05", "DEVOPS-INCIDENT-RESPONSE", "DevOps emergency retains K8s and PagerDuty tools",
    hasK8s && hasPagerDuty,
    `Retained: [${retained7.join(", ")}], Pruned: ${shaped7.prunedToolCount}`);

  // -----------------------------------------------------------------------------------
  // TEST 8: Live Local Ollama d1-omni on Cross-Domain Multi-Intent Turns
  // -----------------------------------------------------------------------------------
  console.log("\n--- 8. Live Local Ollama d1-omni Cross-Domain Multi-Intent Evaluation ---");
  try {
    const oTurn1 = await ollama.classifyTurn({
      message: "Check overdue invoices in Stripe billing and track maritime freight container status.",
      availableTools: MULTI_DOMAIN_CATALOG.map((t) => t.name),
    });
    check("OLLAMA-MD-01", "OLLAMA-CROSS-DOMAIN", "Ollama d1-omni classifies cross-domain tool task accurately",
      oTurn1.intent === "scoped_tool_task",
      `Intent: ${oTurn1.intent}, Confidence: ${oTurn1.confidence}, Allowed tools: [${oTurn1.allowedToolNamespaces.join(", ")}]`);
  } catch (err) {
    check("OLLAMA-MD-01", "OLLAMA-CROSS-DOMAIN", "Ollama cross-domain evaluation", false, `Error: ${(err as Error).message}`);
  }

  // -----------------------------------------------------------------------------------
  // TEST 9: Live Cloud OpenAI gpt-4o-mini on Cross-Domain Multi-Intent Turns
  // -----------------------------------------------------------------------------------
  if (openAIKey) {
    console.log("\n--- 9. Live Cloud OpenAI gpt-4o-mini Cross-Domain Multi-Intent Evaluation ---");
    const oaiTurn1 = await openai.classifyTurn({
      message: "Look up patient 9042 vitals in Epic EHR, review their Salesforce account, and alert the on-call team on Slack.",
      availableTools: MULTI_DOMAIN_CATALOG.map((t) => t.name),
    });
    check("OPENAI-MD-01", "OPENAI-CROSS-DOMAIN", "OpenAI gpt-4o-mini classifies tri-domain compound intent",
      oaiTurn1.intent === "scoped_tool_task" || oaiTurn1.intent === "complex_reasoning",
      `Intent: ${oaiTurn1.intent}, Confidence: ${oaiTurn1.confidence}`);
  }

  console.log("\n=========================================================================");
  console.log(`TOTAL EVALUATIONS: ${outcomes.length}`);
  const passCount = outcomes.filter((o) => o.passed).length;
  console.log(`PASSED: ${passCount} / ${outcomes.length} (${Math.round((passCount / outcomes.length) * 100)}%)`);
  console.log(`FAILED: ${outcomes.length - passCount} / ${outcomes.length}`);
  console.log("=========================================================================");
}

void runMultiDomainMultiIntentEval();
