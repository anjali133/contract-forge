const FIELD_TYPES = ['String', 'Number', 'Boolean', 'Date', 'ObjectId'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

export default function ContractView({ contract, editable = false, onChange }) {
  if (!contract) return null;
  if (!editable) return <ReadOnlyContract contract={contract} />;
  return <EditableContract contract={contract} onChange={onChange} />;
}

function ReadOnlyContract({ contract }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 8 }}>Data models</div>
      {contract.models.map((model) => (
        <div className="model-block" key={model.name}>
          <div className="model-name">{model.name}</div>
          {model.fields.map((f) => (
            <div className="field-row" key={f.name}>
              <span>{f.name}</span>
              <span className="field-type">
                {f.type}{f.type === 'ObjectId' && f.ref ? ` → ${f.ref}` : ''}{f.required ? '' : ' · optional'}
              </span>
            </div>
          ))}
        </div>
      ))}

      <div className="label" style={{ margin: '18px 0 8px' }}>Endpoints</div>
      <div>
        {contract.endpoints.map((ep, i) => (
          <div className="endpoint-row" key={i}>
            <span className={`method-badge method-${ep.method}`}>{ep.method}</span>
            <span>{ep.path}</span>
            <span className="endpoint-desc">{ep.description}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EditableContract({ contract, onChange }) {
  const modelNames = contract.models.map((m) => m.name);

  function updateModel(modelIndex, updater) {
    onChange({ ...contract, models: contract.models.map((m, i) => (i === modelIndex ? updater(m) : m)) });
  }

  function updateModelName(modelIndex, name) {
    const oldName = contract.models[modelIndex].name;
    const models = contract.models.map((m, i) => {
      const renamed = i === modelIndex ? { ...m, name } : m;
      // Keep other models' ref fields pointing at the renamed model in sync,
      // so renaming doesn't silently turn a valid ref into a dangling one.
      return {
        ...renamed,
        fields: renamed.fields.map((f) => (f.type === 'ObjectId' && f.ref === oldName ? { ...f, ref: name } : f))
      };
    });
    const endpoints = contract.endpoints.map((ep) => (ep.model === oldName ? { ...ep, model: name } : ep));
    onChange({ ...contract, models, endpoints });
  }

  function addModel() {
    let name = 'NewModel';
    let n = 2;
    while (modelNames.includes(name)) name = `NewModel${n++}`;
    const slug = name.toLowerCase();
    const newModel = { name, fields: [{ name: 'title', type: 'String', required: true, default: null }] };
    const newEndpoints = [
      { method: 'GET', path: `/api/${slug}s`, model: name, description: `list ${name}` },
      { method: 'POST', path: `/api/${slug}s`, model: name, description: `create ${name}` },
      { method: 'GET', path: `/api/${slug}s/:id`, model: name, description: `get one ${name}` },
      { method: 'PUT', path: `/api/${slug}s/:id`, model: name, description: `update ${name}` },
      { method: 'DELETE', path: `/api/${slug}s/:id`, model: name, description: `delete ${name}` }
    ];
    onChange({ ...contract, models: [...contract.models, newModel], endpoints: [...contract.endpoints, ...newEndpoints] });
  }

  function removeModel(modelIndex) {
    const removedName = contract.models[modelIndex].name;
    const models = contract.models
      .filter((_, i) => i !== modelIndex)
      // Drop any ref field that pointed at the removed model rather than
      // leave it dangling -- a fresh integrity warning right after the
      // removal the user asked for would just be confusing.
      .map((m) => ({ ...m, fields: m.fields.filter((f) => !(f.type === 'ObjectId' && f.ref === removedName)) }));
    const endpoints = contract.endpoints.filter((ep) => ep.model !== removedName);
    onChange({ ...contract, models, endpoints });
  }

  function updateField(modelIndex, fieldIndex, patch) {
    updateModel(modelIndex, (m) => ({ ...m, fields: m.fields.map((f, i) => (i === fieldIndex ? { ...f, ...patch } : f)) }));
  }

  function addField(modelIndex) {
    updateModel(modelIndex, (m) => ({ ...m, fields: [...m.fields, { name: 'newField', type: 'String', required: false, default: null }] }));
  }

  function removeField(modelIndex, fieldIndex) {
    updateModel(modelIndex, (m) => ({ ...m, fields: m.fields.filter((_, i) => i !== fieldIndex) }));
  }

  function updateEndpoint(index, patch) {
    onChange({ ...contract, endpoints: contract.endpoints.map((ep, i) => (i === index ? { ...ep, ...patch } : ep)) });
  }

  function addEndpoint() {
    const firstModel = contract.models[0]?.name || '';
    onChange({
      ...contract,
      endpoints: [...contract.endpoints, { method: 'POST', path: '/api/resource/:id/action', model: firstModel, description: 'custom action' }]
    });
  }

  function removeEndpoint(index) {
    onChange({ ...contract, endpoints: contract.endpoints.filter((_, i) => i !== index) });
  }

  return (
    <div>
      <div className="label" style={{ marginBottom: 8 }}>App name</div>
      <input
        className="contract-input mono"
        style={{ width: '100%', marginBottom: 18 }}
        value={contract.appName}
        onChange={(e) => onChange({ ...contract, appName: e.target.value })}
      />

      <div className="card-header" style={{ marginBottom: 8 }}>
        <div className="label">Data models</div>
        <button onClick={addModel}>+ Add model</button>
      </div>

      {contract.models.map((model, mi) => (
        <div className="model-block" key={mi}>
          <div className="model-block-header">
            <input className="contract-input mono" value={model.name} onChange={(e) => updateModelName(mi, e.target.value)} />
            <button className="ghost-button" onClick={() => removeModel(mi)}>Remove model</button>
          </div>

          {model.fields.map((f, fi) => (
            <div className="field-row-edit" key={fi}>
              <input
                className="contract-input"
                value={f.name}
                onChange={(e) => updateField(mi, fi, { name: e.target.value })}
              />
              <select
                className="contract-input"
                value={f.type}
                onChange={(e) => updateField(mi, fi, { type: e.target.value })}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {f.type === 'ObjectId' && (
                <select className="contract-input" value={f.ref || ''} onChange={(e) => updateField(mi, fi, { ref: e.target.value })}>
                  <option value="">ref model…</option>
                  {modelNames.filter((n) => n !== model.name).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              )}
              <label className="checkbox-label">
                <input type="checkbox" checked={!!f.required} onChange={(e) => updateField(mi, fi, { required: e.target.checked })} />
                required
              </label>
              <button className="ghost-button" onClick={() => removeField(mi, fi)} aria-label={`Remove field ${f.name}`}>×</button>
            </div>
          ))}
          <button className="ghost-button" onClick={() => addField(mi)}>+ Add field</button>
        </div>
      ))}

      <div className="card-header" style={{ margin: '18px 0 8px' }}>
        <div className="label">Endpoints</div>
        <button onClick={addEndpoint}>+ Add endpoint</button>
      </div>

      {contract.endpoints.map((ep, i) => (
        <div className="endpoint-row-edit" key={i}>
          <select
            className={`contract-input mono method-badge method-${ep.method}`}
            value={ep.method}
            onChange={(e) => updateEndpoint(i, { method: e.target.value })}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input className="contract-input mono" value={ep.path} onChange={(e) => updateEndpoint(i, { path: e.target.value })} />
          <select className="contract-input" value={ep.model} onChange={(e) => updateEndpoint(i, { model: e.target.value })}>
            {modelNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <input
            className="contract-input"
            value={ep.description}
            onChange={(e) => updateEndpoint(i, { description: e.target.value })}
          />
          <button className="ghost-button" onClick={() => removeEndpoint(i)} aria-label={`Remove endpoint ${ep.method} ${ep.path}`}>×</button>
        </div>
      ))}
    </div>
  );
}
