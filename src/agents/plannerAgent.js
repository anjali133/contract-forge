import { callAgent } from '../utils/openaiClient.js';
import { applyContractPatch } from '../orchestrator/contractPatch.js';

const SYSTEM_PROMPT = `You are the planner agent in a multi-agent app builder.
Given a plain-English description of an app, output ONLY a JSON object describing an API contract. No explanation, no markdown fences, no text outside the JSON.

Shape:
{
  "appName": "kebab-case-name",
  "models": [
    {
      "name": "PascalCaseModelName",
      "fields": [
        { "name": "fieldName", "type": "String|Number|Boolean|Date|ObjectId", "required": true, "default": null, "ref": "PascalCaseModelName" }
      ]
    }
  ],
  "endpoints": [
    { "method": "GET|POST|PUT|DELETE", "path": "/api/resource" , "model": "PascalCaseModelName", "description": "short description" }
  ]
}

Rules:
- Always include full CRUD endpoints (list, create, get one, update, delete) for every model, using REST conventions and ":id" for the identifier segment.
- Add extra action endpoints only if the description explicitly implies a behavior beyond CRUD (e.g. "borrow a book" -> POST /api/books/:id/borrow).
- Keep it to 1-3 models unless the description clearly needs more.
- Give every model a sensible set of fields based on the description.
- Use "type": "ObjectId" with a "ref" property whenever the description implies one thing belongs to, is assigned to, or is associated with another -- e.g. "tasks belong to a project" means the Task model gets a field like { "name": "project", "type": "ObjectId", "ref": "Project", "required": true }. The "ref" value must exactly match another model's "name" in this same contract. Only add this when a relationship is actually implied -- don't invent one.
- "ref" is required whenever "type" is "ObjectId", and is meaningless (omit it) for every other type.`;

export async function runPlannerAgent(userDescription) {
  const { data, usage } = await callAgent({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userDescription
  });
  return { contract: data, usage };
}

// "Add a feature" mode: the planner receives an already-built contract plus
// a new feature description, and outputs a PATCH -- only what's new or
// actually needs to change -- rather than the whole contract. Merging that
// patch onto the existing contract happens in code (applyContractPatch),
// which guarantees anything the patch doesn't mention survives untouched.
// That in turn is what lets the incremental build (contractDiff.js) still
// recognize unrelated models as unchanged and skip regenerating them.
const EXTEND_SYSTEM_PROMPT = `You are the planner agent in a multi-agent app builder, in "add a feature" mode.
You will receive an EXISTING contract (already built) and a description of a NEW feature to add to it.
Output ONLY a JSON patch describing what needs to change -- never the whole contract, and never anything that already exists unless it genuinely must change for the new feature. No explanation, no markdown fences, no text outside the JSON.

Shape:
{
  "newModels": [ { "name": "PascalCaseModelName", "fields": [ { "name": "fieldName", "type": "String|Number|Boolean|Date|ObjectId", "required": true, "default": null, "ref": "PascalCaseModelName" } ] } ],
  "modifiedModels": [ { "name": "<an EXISTING model's exact name>", "fields": [ /* that model's COMPLETE new field list -- every existing field it should keep, plus whatever's new */ ] } ],
  "removedModels": ["<an EXISTING model's exact name>"],
  "newEndpoints": [ { "method": "GET|POST|PUT|DELETE", "path": "/api/...", "model": "PascalCaseModelName", "description": "short description" } ],
  "removedEndpoints": [ { "method": "GET|POST|PUT|DELETE", "path": "/api/..." } ]
}

Rules:
- Only include a model in "modifiedModels" if the new feature genuinely requires changing one of its fields. If you do include one, give its COMPLETE field list, since this replaces the model's fields entirely -- omitting an existing field there deletes it.
- Never mention an existing model or endpoint you are not changing. Leaving it out means it stays exactly as it is -- that is the entire point of this mode, and any part you re-describe instead of omitting will be treated as a real change and get needlessly regenerated.
- Follow the same conventions as building a contract from scratch: full CRUD for a brand new model by default, "ref" required whenever "type" is "ObjectId" and must exactly match another model's name (new or existing), extra endpoints only when the feature genuinely implies one beyond CRUD.
- Any field missing from this shape (e.g. "newModels" when nothing new is needed) should simply be omitted or empty, not invented.`;

export async function runPlannerExtendAgent(existingContract, featureDescription) {
  const { data, usage } = await callAgent({
    systemPrompt: EXTEND_SYSTEM_PROMPT,
    userPrompt: `Existing contract:\n${JSON.stringify(existingContract, null, 2)}\n\nNew feature to add:\n${featureDescription}`
  });
  const contract = applyContractPatch(existingContract, data);
  return { contract, usage };
}
