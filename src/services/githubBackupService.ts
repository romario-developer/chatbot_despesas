import { Buffer } from 'node:buffer';

import { dayjs, TZ } from '../utils/dates';

const GITHUB_API_BASE = 'https://api.github.com';

export type GitHubBackupConfig = {
  token: string;
  repo: string;
  branch: string;
};

function getEnvConfig(): GitHubBackupConfig {
  const token = process.env.GITHUB_BACKUP_TOKEN?.trim();
  const repo = process.env.GITHUB_BACKUP_REPO?.trim();
  const branch = process.env.GITHUB_BACKUP_BRANCH?.trim() || 'main';
  if (!token || !repo) {
    throw new Error('GITHUB_BACKUP_TOKEN e GITHUB_BACKUP_REPO precisam estar definidos');
  }
  return { token, repo, branch };
}

function buildHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'chatbot-despesas-backup',
  };
}

async function fetchFileSha(path: string, config: GitHubBackupConfig) {
  const url = `${GITHUB_API_BASE}/repos/${config.repo}/contents/${path}?ref=${config.branch}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(config.token),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Não foi possível verificar arquivo ${path}: ${response.statusText}`);
  }
  const data = await response.json();
  return data.sha as string;
}

export async function uploadUserBackupToGithub(userId: number, snapshot: unknown) {
  const config = getEnvConfig();
  const path = `backups/users/${userId}.json`;
  const sha = await fetchFileSha(path, config);
  const message = `backup(user): ${userId} ${dayjs().tz(TZ).format('YYYY-MM-DD HH:mm')}`;
  const content = Buffer.from(JSON.stringify(snapshot, null, 2)).toString('base64');

  const url = `${GITHUB_API_BASE}/repos/${config.repo}/contents/${path}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: buildHeaders(config.token),
    body: JSON.stringify({
      message,
      branch: config.branch,
      content,
      sha,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Erro ao subir backup (${response.status}): ${body}`);
  }
}
