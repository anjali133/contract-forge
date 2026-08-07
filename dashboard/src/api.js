async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function planApp(description) {
  return request('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description })
  });
}

export function buildApp(contract, generationId) {
  return request('/api/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract, generationId })
  });
}

export function validateContractDraft(contract) {
  return request('/api/validate-contract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract })
  });
}

export function planExtend(existingContract, description) {
  return request('/api/plan-extend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ existingContract, description })
  });
}

export function fetchHistory() {
  return request('/api/history');
}

export function fetchGeneration(id) {
  return request(`/api/history/${id}`);
}

export function downloadUrl(appName) {
  return `/api/download/${appName}`;
}
