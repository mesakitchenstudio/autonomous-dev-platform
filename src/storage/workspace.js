import fs from 'node:fs/promises';
import path from 'node:path';
export class WorkspaceManager {
  constructor(root){this.root=path.resolve(root)}
  async ensure(project){
    if(project.projectPath) return project.projectPath;
    const dir=path.join(this.root,project.id); await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'PROJECT_IDEA.md'),`# Owner idea\n\n${project.idea}\n`,'utf8');
    return dir;
  }
}
