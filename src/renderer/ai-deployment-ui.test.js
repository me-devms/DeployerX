const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDirectory = __dirname;

test('GitHub repository listing fetches every page, including beyond 2,000 repositories', async () => {
  const main = await fs.readFile(path.join(rendererDirectory, '..', 'main.js'), 'utf8');
  const source = main.slice(main.indexOf('async function listGithubRepositories()'), main.indexOf('async function downloadGithubArchive('));
  let pages = 0;
  const context = vm.createContext({
    readSettings: async () => ({}),
    githubToken: async () => 'test-token',
    githubRequest: async (_token, endpoint) => {
      const page = Number(new URL(endpoint, 'https://api.github.com').searchParams.get('page'));
      assert.equal(page, ++pages);
      return Array.from({ length: page <= 20 ? 100 : 1 }, (_, index) => ({
        id: (page - 1) * 100 + index,
        full_name: `team/repo-${page}-${index}`,
        default_branch: 'main'
      }));
    }
  });
  const repositories = await vm.runInContext(`${source}\nlistGithubRepositories()`, context);
  assert.equal(pages, 21);
  assert.equal(repositories.length, 2001);
  assert.equal(repositories.at(-1).fullName, 'team/repo-21-0');
});

test('provides the accessible deployment list and configuration workflow', async () => {
  const [html, renderer, preload] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'index.html'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, '..', 'preload.js'), 'utf8')
  ]);

  assert.match(html, /id="aiDeploymentsButton"[\s\S]*?<use href="#icon-layers"><\/use>[\s\S]*?<span>Deployment<\/span>/);
  assert.ok(html.indexOf('id="topSshButton"') < html.indexOf('id="aiDeploymentsButton"'));
  assert.ok(html.indexOf('id="aiDeploymentsButton"') < html.indexOf('id="serverMonitoringButton"'));
  assert.match(html, /id="aiDeploymentTableWrap"[\s\S]*?<caption class="sr-only">Saved external deployments<\/caption>/);
  assert.match(html, /<th scope="col">#<\/th>/);
  assert.match(html, /<th scope="col">Actions<\/th>/);
  assert.match(html, /id="aiDeploymentFilterButton"[^>]+aria-controls="aiDeploymentFilterPanel"/);
  assert.match(html, /id="aiDeploymentServerFilterOptions"/);
  assert.match(html, /data-ai-deployment-status-filter/);
  assert.doesNotMatch(html, /id="aiExternalDeploymentsHeading"/);
  assert.doesNotMatch(html, /id="aiDeploymentTableViewButton"|id="aiDeploymentListViewButton"/);
  assert.match(html, /id="aiDeploymentProject" required/);
  assert.match(html, /id="aiDeploymentSourceType" required/);
  assert.match(html, /id="aiDeploymentGithubRepo"[^>]+data-project-dropdown-search="true"[^>]+Search repositories \(regex\)/);
  assert.match(html, /id="aiDeploymentProject"[^>]+Search servers \(regex\)/);
  assert.match(html, /id="aiDeploymentAutoDeploy"/);
  assert.match(html, /id="githubIntegrationConnectButton"/);
  assert.match(html, /<dialog id="githubIntegrationDialog"/);
  assert.match(html, /id="aiDeploymentProject"[^>]+data-project-dropdown-search="true"/);
  assert.match(html, /id="aiDeploymentLocalPath"[^>]+required/);
  assert.doesNotMatch(html, /id="aiDeploymentRemotePath"[^>]+required/);
  assert.match(html, /id="aiDeploymentRemotePath"[\s\S]*?Leave blank to let the agent choose a destination/);
  assert.match(html, /id="aiDeploymentPrompt"[^>]+required/);
  assert.match(html, /id="aiDeploymentClearPromptButton"/);
  assert.match(html, /id="aiDeploymentBackButton"[^>]+icon-only[^>]+aria-label="Back to deployments"/);
  assert.match(html, /class="ai-deployment-identity-grid"/);
  assert.match(html, /class="ai-deployment-copy-grid"/);
  assert.match(html, /class="ai-deployment-saved-prompt-field"[\s\S]*?id="aiDeploymentSavedPrompt"[\s\S]*?id="aiDeploymentDeletePromptButton"[^>]+icon-only[^>]+aria-label="Delete selected saved prompt"[^>]+disabled/);
  assert.match(html, /id="aiDeploymentClearInstructionsButton"/);
  assert.match(html, /<dialog id="aiDeploymentFolderDialog"[^>]+aria-labelledby="aiDeploymentFolderHeading"/);
  assert.match(html, /id="aiDeploymentFolderProtocol"[^>]+aria-label="Server folder connection"/);
  assert.match(html, /<dialog id="aiDeploymentRunDialog"[^>]+aria-labelledby="aiDeploymentRunHeading"[^>]+aria-describedby="aiDeploymentRunDescription"/);
  assert.match(html, /id="aiDeploymentTemporaryPrompt"[^>]+maxlength="8000"/);
  assert.match(html, /id="aiDeploymentAttachFilesButton"/);
  assert.match(html, /<dialog id="aiDeploymentLogDialog"[^>]+aria-labelledby="aiDeploymentLogHeading"/);
  assert.match(html, /<ol id="aiDeploymentLogHistory"/);
  assert.match(html, /<dialog id="aiDeploymentLogDetailDialog"[^>]+aria-labelledby="aiDeploymentLogDetailHeading"/);
  assert.match(html, /id="aiDeploymentAgent" required/);
  assert.match(html, /id="aiDeploymentSubmitButton"[\s\S]*?<span>Save Deployment<\/span>/);
  assert.doesNotMatch(html, /id="aiDeploymentRefreshButton"/);

  assert.match(renderer, /els\.aiDeploymentsButton\.addEventListener\('click'/);
  assert.match(renderer, /data-ai-deployment-run=/);
  assert.match(renderer, /data-ai-deployment-stop=/);
  assert.match(renderer, /data-ai-deployment-edit=/);
  assert.match(renderer, /data-ai-deployment-duplicate=/);
  assert.match(renderer, /data-ai-deployment-delete=/);
  assert.match(renderer, /data-ai-deployment-log=/);
  assert.match(renderer, /function renderAiDeploymentLog\(\)/);
  assert.match(renderer, /function renderAiDeploymentLogDetail\(\)/);
  assert.match(renderer, /data-ai-deployment-log-run=/);
  assert.match(renderer, /data-project-dropdown-search-input/);
  assert.match(renderer, /pattern = new RegExp\(query, 'i'\)/);
  assert.match(renderer, /Invalid regular expression\./);
  assert.match(renderer, /option\.hidden = !visible/);
  assert.doesNotMatch(renderer, /else await startSavedAiDeployment\(saved\.id\)/);
  assert.match(renderer, /window\.deployerx\.stopAiDeployment\(runId\)/);
  assert.match(renderer, /function updateAiDeploymentSourceFields\(\)/);
  assert.match(renderer, /loadGithubIntegration\(\{ repositories: true \}\)/);
  assert.match(renderer, /serverFilters: new Set\(\)/);
  assert.match(renderer, /statusFilters: new Set\(\)/);
  assert.match(renderer, /function deleteSelectedAiDeploymentPrompt\(\)/);
  assert.doesNotMatch(renderer, /function openAiDeploymentForm[\s\S]*?aiDeploymentForm\.reset\(\)/);
  assert.match(renderer, /const protocol = els\.aiDeploymentFolderProtocol\.value;[\s\S]*?window\.deployerx\.ftpConnect\(\{[\s\S]*?protocol/);
  assert.match(renderer, /promptReusable: false/);
  assert.match(renderer, /aiDeploymentDeletePromptButton\.addEventListener\('click'/);
  assert.doesNotMatch(renderer, /deployment\?\.prompt \|\| recent\.prompt/);
  assert.match(renderer, /els\.aiDeploymentRemotePath\.value = state\.aiDeployments\.folderPath/);
  assert.match(renderer, /openAiDeploymentRunDialog\(runId\)/);
  assert.match(renderer, /window\.deployerx\.runAiDeployment\(id, runOptions\)/);
  assert.match(renderer, /closeAiDeploymentRunDialog\(\{ force: true \}\);\s*await startSavedAiDeployment\(id, options\);/);
  assert.match(preload, /listAiDeployments: \(\) => ipcRenderer\.invoke\('ai-deployments:list'\)/);
  assert.match(preload, /connectGithubIntegration: \(payload\) => ipcRenderer\.invoke\('github-integration:connect', payload\)/);
  assert.match(preload, /selectAiDeploymentTemporaryFiles: \(\) => ipcRenderer\.invoke\('ai-deployments:select-temporary-files'\)/);
  assert.match(preload, /stopAiDeployment: \(runId\) => ipcRenderer\.invoke\('ai-deployments:stop', String\(runId \|\| ''\)\)/);
  assert.match(preload, /onAiDeploymentEvent:/);
});

test('deployment navigation uses a full-width view and preserves keyboard focus', async () => {
  const [styles, renderer] = await Promise.all([
    fs.readFile(path.join(rendererDirectory, 'styles.css'), 'utf8'),
    fs.readFile(path.join(rendererDirectory, 'renderer.js'), 'utf8')
  ]);

  assert.match(renderer, /const isFullPageView = isProfile \|\| isSshFile \|\| isTeam \|\| isAiDeployments;/);
  assert.match(renderer, /requestAnimationFrame\(\(\) => els\.aiDeploymentFormHeading\.focus\(\)\)/);
  assert.match(styles, /\.ai-deployment-filter-panel \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.ai-deployment-filter-options input \{[\s\S]*?accent-color: var\(--primary\);/);
  assert.match(styles, /html\[data-theme\] #aiDeploymentSearch \{[\s\S]*?box-shadow: none;/);
  assert.match(styles, /\.ai-deployment-field-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.ai-deployment-identity-grid,[\s\S]*?\.ai-deployment-copy-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(renderer, /setAiDeploymentFilterPanelOpen/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.ai-deployment-field-grid/);
});
