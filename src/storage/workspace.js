import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isolateExistingRepository,
  isGitRepository,
  managedWorkspaceRoot,
  RepositoryType
} from '../git/worktree.js';
import { prepareEmptyWorkspace } from '../provision/pipeline.js';

export class WorkspaceManager {
  constructor(root) {
    this.root = path.resolve(root || managedWorkspaceRoot());
  }

  async ensure(project) {
    if (project.repository?.workspacePath) {
      await fs.mkdir(project.repository.workspacePath, { recursive: true });
      return project.repository.workspacePath;
    }
    const ownerPath = project.projectPath;
    if (ownerPath && await isGitRepository(ownerPath)) {
      project.repository = await isolateExistingRepository(project, ownerPath, this.root);
      return project.repository.workspacePath;
    }
    if (ownerPath && !(await isGitRepository(ownerPath))) {
      const error = new Error('Existing-repository Cursor mode requires a Git repository.');
      error.code = 'WORKSPACE_UNSAFE';
      throw error;
    }
    project.repository = await prepareEmptyWorkspace(project, this.root);
    if (!project.repository.cursorBackend && project.demo) {
      project.repository.cursorBackend = 'MOCK';
    }
    if (!project.repository.repositoryType) {
      project.repository.repositoryType = RepositoryType.UNPROVISIONED_NEW_PROJECT;
    }
    return project.repository.workspacePath;
  }
}
