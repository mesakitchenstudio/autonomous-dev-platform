import fs from 'node:fs/promises';
import path from 'node:path';

export async function importJsonProjects(store, dataDir, { logger = console } = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  const files = (await fs.readdir(dataDir)).filter(name => name.endsWith('.json') && !name.endsWith('.tmp') && !name.endsWith('.imported.json'));
  const results = [];
  for (const file of files) {
    const sourcePath = path.join(dataDir, file);
    const raw = await fs.readFile(sourcePath, 'utf8');
    const project = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!project?.id) {
      results.push({ file, status: 'skipped', reason: 'missing_id' });
      continue;
    }
    const existing = await store.adapter.query('SELECT project_id FROM json_imports WHERE project_id = $1', [project.id]);
    if (existing.rows.length) {
      results.push({ file, id: project.id, status: 'already_imported' });
      continue;
    }
    const present = await store.adapter.query('SELECT id FROM projects WHERE id = $1', [project.id]);
    project.importedFromJson = true;
    if (!present.rows.length) await store.save(project);
    await store.adapter.query(
      'INSERT INTO json_imports (project_id, source_path) VALUES ($1,$2) ON CONFLICT (project_id) DO NOTHING',
      [project.id, sourcePath]
    );
    await store.appendEvent(project.id, 'json.imported', { sourcePath: file });
    results.push({ file, id: project.id, status: present.rows.length ? 'marked' : 'imported' });
    logger.info?.(`Imported ${file} as ${project.id}`) || logger.log?.(`Imported ${file} as ${project.id}`);
  }
  return results;
}
