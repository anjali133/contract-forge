import { callAgent } from '../utils/openaiClient.js';
import { filterFilesToModels } from './modelFiles.js';

const SYSTEM_PROMPT = `You are the frontend agent in a multi-agent app builder.
You will receive a JSON API contract. Generate React components that call EXACTLY the endpoints in the contract using fetch \u2014 no invented, renamed, or missing endpoints.

Every single endpoint listed in the contract must be called by the generated code somewhere \u2014 there is no such thing as an optional endpoint.

Output ONLY a JSON object shaped like:
{
  "files": {
    "src/components/<ModelName>List.jsx": "<full file content>"
  }
}

Do NOT generate "src/App.jsx" -- that file is assembled separately, deterministically, from the final list of models, so it stays correct even when only some models' components are regenerated.

For each model, build its list component to cover every endpoint that model has in the contract, using this mapping:
- List endpoint (GET collection) \u2192 fetch on mount (useEffect) and render the records.
- Create endpoint (POST collection) \u2192 a small form that posts a new record.
- Get-one endpoint (GET /:id) + update endpoint (PUT or PATCH /:id) \u2192 an "Edit" button per row that first GETs that single record to load fresh data into the form, then saves via the update endpoint. This GET call is REQUIRED even though the row already has this record's data from the list fetch -- do not "optimize" it away by reusing the list data instead. The get-one endpoint exists in the contract specifically to be called, and skipping it because the data looks redundant is the single most common mistake made here: it leaves that endpoint uncalled, which always fails validation.
- Delete endpoint (DELETE /:id) \u2192 a "Delete" button per row.
- Any OTHER endpoint for that model that isn't one of the four standard CRUD shapes above (e.g. a custom action like a "/borrow" or "/return" style path) \u2192 a separate labeled button per row that calls that exact method and path. Use the endpoint's "description" field as the button label.
- If a model's contract doesn't include one of these endpoint types, simply skip that UI piece \u2014 but never skip one that IS present in the contract.
- If a model has a field with "type": "ObjectId" (a reference to another model, named in that field's "ref"), the create form (and edit form, if one exists) must let the user pick a related record: fetch that other model's list endpoint once on mount (find it in the contract's endpoints for that "ref" model), and render the field as a <select> whose options are value={relatedRecord._id} and label is the related record's most name-like field (try "name", then "title", then fall back to the related record's _id).
- Since the backend populates ObjectId/ref fields, a fetched record's reference field will already be the full related object, not a raw id \u2014 display it using that same name-like field (e.g. task.project?.name), never the raw id string.

Rules:
- Filenames must use the model's EXACT name from the contract, same casing -- a model named "TeamMember" produces exactly "src/components/TeamMemberList.jsx". Never lowercase it, never pluralize it.
- Use React hooks only (useState, useEffect). No external UI libraries \u2014 plain elements with minimal inline styling is fine.
- Every fetch call's URL and HTTP method must match a path+method pair from the contract exactly (use template literals like \`/api/books/\${id}\` for the ":id" segment).
- MongoDB records use "_id" as their identifier field, never a plain "id". When reading a record's id from fetched data (for a URL, a React "key" prop, or anything else), always use "record._id" \u2014 "record.id" will be undefined and silently break every action that needs it.
- No explanations, no markdown fences \u2014 valid JSON only, and every value in "files" must be a plain string of code, not nested JSON.`;

// onlyModels, when given, restricts output to just those models -- used by
// incremental rebuilds, where every other model's list component already
// exists and is being reused untouched.
export async function runFrontendAgent(contract, feedback = null, onlyModels = null) {
  const scopeNote = onlyModels
    ? `\n\nOnly generate the list component for these models this time -- ${onlyModels.join(', ')}. Every other model's component already exists elsewhere; do not include them in your output, even though you can see them in the contract above (they're there so you know what a "ref" points to and what its list endpoint is).`
    : '';
  const userPrompt =
    (feedback
      ? `Contract:\n${JSON.stringify(contract, null, 2)}\n\nThe validator found these problems in your previous attempt \u2014 fix them and regenerate the affected files:\n${feedback}`
      : `Contract:\n${JSON.stringify(contract, null, 2)}`) + scopeNote;

  const { data, usage } = await callAgent({ systemPrompt: SYSTEM_PROMPT, userPrompt });
  const files = onlyModels ? filterFilesToModels(data.files, onlyModels, 'frontend') : data.files;
  return { files, usage };
}
