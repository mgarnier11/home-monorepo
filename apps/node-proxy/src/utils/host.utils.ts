import fs from 'fs';
import jsYaml from 'js-yaml';
import { logger } from 'logger';
import path from 'path';
import { fileURLToPath } from 'url';

import { Host } from '../classes/host.class.js';
import { HostConfig } from './interfaces.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const hosts: Host[] = [];
const configFilePath = path.resolve(__dirname, process.env.CONFIG_FILE ?? '../../config.json');

const lastConfig: HostConfig[] = [];

const loadConfig = async (): Promise<HostConfig[]> => {
  try {
    if (fs.existsSync(configFilePath)) {
      const dataStr = await fs.promises.readFile(configFilePath, 'utf-8');

      if (dataStr !== '') {
        if (configFilePath.endsWith('.json')) {
          return JSON.parse(dataStr) as HostConfig[];
        }
        return jsYaml.load(dataStr) as HostConfig[];
      }
    }
  } catch (err) {
    logger.error('Error loading config file : ', err);
  }

  return [];
};

const saveConfig = async (data: HostConfig[]) => {
  const stringData = configFilePath.endsWith('.json') ? JSON.stringify(data, null, 4) : jsYaml.dump(data);

  await fs.promises.writeFile(configFilePath, stringData, 'utf-8');
};

const hostConfigUpdated = () => {
  const data = hosts.map((host) => host.config);

  saveConfig(data);
};

export const getHost = (host: string): Host | undefined => {
  return hosts.find((h) => h.config.name.toLowerCase() === host.toLowerCase());
};

export const setupConfigListenner = () => {
  logger.debug('Loading config from : ', configFilePath);

  const configFileChanged = async (configs: HostConfig[]) => {
    await disposeHosts();

    logger.info('Hosts loaded : ', configs);

    hosts.push(...configs.map((config) => new Host(config, hostConfigUpdated)));
  };

  setInterval(async () => {
    const config = await loadConfig();

    if (JSON.stringify(config) !== JSON.stringify(lastConfig)) {
      lastConfig.splice(0, lastConfig.length);
      lastConfig.push(...config);

      logger.info('Config file changed, triggering callback');

      configFileChanged(config);
    }
  }, 30 * 1000);
};

export const disposeHosts = async () => {
  for (const host of hosts) {
    await host.dispose();

    logger.info('Host disposed : ', host.config.name);
  }

  hosts.splice(0, hosts.length);

  logger.info('All hosts disposed');
};