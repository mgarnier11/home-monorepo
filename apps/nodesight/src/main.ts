import express from 'express';

import { setVersionEndpoint } from '@libs/api-version';
import { logger } from '@libs/logger';

import { Cpu } from './hwInfo/cpu';
import { Gpu } from './hwInfo/gpu';
import { HwInfo } from './hwInfo/index';
import { Network } from './hwInfo/network';
import { Ram } from './hwInfo/ram';
import { Storage } from './hwInfo/storage';
import { sendToStatsApi } from './statsApi';
import { config } from './utils/config';
import { Current } from './utils/interfaces';

logger.setAppName('nodesight');

const app = express();

setVersionEndpoint(app);

let current: Current | undefined = undefined;

let lastSendSuccess = false;

const updateAll = async () => {
  current = await HwInfo.current();

  if (config.enableStatsApi) {
    lastSendSuccess = await sendToStatsApi(current);
  }
};

setInterval(updateAll, config.updateInterval);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');

  next();
});

app.get('/', (req, res) => {
  res.send('OK');
});

app.get('/lastSendSuccess', (req, res) => {
  res.status(lastSendSuccess ? 200 : 500).send(lastSendSuccess ? 'OK' : 'ERROR');
});

app.get('/cpu', async (req, res) => {
  res.send(await Cpu.current());
});

app.get('/ram', async (req, res) => {
  res.send(await Ram.current());
});

app.get('/gpu', async (req, res) => {
  res.send(await Gpu.current());
});

app.get('/network', async (req, res) => {
  res.send(await Network.current());
});

app.get('/storage', async (req, res) => {
  res.send(await Storage.current());
});

app.get('/current', async (req, res) => {
  res.send(current);
});

app.get('/static', async (req, res) => {
  res.send(await HwInfo.staticInfo());
});

app.get('/all', async (req, res) => {
  res.send({
    static: await HwInfo.staticInfo(),
    current: current,
  });
});

app.listen(config.serverPort, () => {
  logger.info(`Server listening on port ${config.serverPort}`);
});
