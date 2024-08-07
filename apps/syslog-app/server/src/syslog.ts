import type { DockerMessage, SyslogMessage } from '@shared/interfaces';
import { createSocket, Socket } from 'dgram';
import fs from 'fs';
import path from 'path';

import { logger } from '@libs/logger';
import { SimpleCache } from '@libs/utils';
import { getDockerMessage, getMessageKey } from '@shared/utils';

import { config } from './config';

import type { WriteStream } from './interfaces';
export class SyslogServer {
  private socket: Socket;

  private fileWatcher: NodeJS.Timeout;
  private fileStreams: { [key: string]: WriteStream } = {}; // key = full path of the file
  private filePathCache = new SimpleCache<string>(60); // key = messageKey => value = full path of the file

  private lastMessageDate: number = 0; // timestamp of the last message received to slow down the spam in dev mode

  constructor() {
    this.socket = createSocket('udp4');

    this.fileWatcher = setInterval(() => {
      // log('Checking file streams');

      for (const key in this.fileStreams) {
        const fileStream = this.fileStreams[key];

        if (Date.now() - fileStream!.lastWrite > 30 * 1000) {
          // log(`Closing file stream for ${key}`);

          fileStream!.stream.end();
          delete this.fileStreams[key];
        }
      }
    }, 30 * 100);
  }

  public start(port: number) {
    this.socket.on('listening', () => {
      logger.info(`Syslog server listening on port ${port}`);
    });

    this.socket.on('error', (err) => {
      logger.info('Syslog server error', err);
    });

    this.socket.on('message', (msg, rinfo) => {
      if (config.devMode) {
        if (Date.now() - this.lastMessageDate < 10000) {
          return;
        }
      }

      this.handleSyslogMessage({
        date: new Date(),
        host: config.hostsMap[rinfo.address] || rinfo.address,
        message: msg.toString('utf8'),
        protocol: rinfo.family,
      });

      this.lastMessageDate = Date.now();
    });

    this.socket.on('close', () => {
      logger.info('Syslog server closed');
    });

    this.socket.bind(port);
  }

  public async stop() {
    this.socket.close();
  }

  private handleSyslogMessage = (msg: SyslogMessage) => {
    const isDockerMessage = msg.message.includes('DCMSG:');

    if (isDockerMessage) {
      const dockerMessage = getDockerMessage(msg.message);

      msg.dockerMessage = dockerMessage;
    }

    this.writeMessage(msg);

    // log(msg);
  };

  private writeMessage = (msg: SyslogMessage) => {
    const fileStream = this.getFileStream(msg);

    const msgStr = JSON.stringify({ ...msg, message: undefined });

    fileStream.stream.write(msgStr + '\n');
    fileStream.lastWrite = Date.now();

    if (fileStream.initialFileSize + fileStream.stream.bytesWritten > config.maxLogFileSize) {
      this.filePathCache.invalidate(getMessageKey(msg));
    }
  };

  private getFileStream = (msg: SyslogMessage): WriteStream => {
    const logFilePath = this.getLogFilePath(msg);

    if (!this.fileStreams[logFilePath]) {
      // log(`Creating file stream for ${logFilePath}`);

      const logDir = path.dirname(logFilePath);

      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const stream = fs.createWriteStream(logFilePath, { flags: 'a' });

      this.fileStreams[logFilePath] = {
        stream,
        lastWrite: 0,
        initialFileSize: fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0,
      };
    }

    return this.fileStreams[logFilePath]!;
  };

  private getLogFilePath = (msg: SyslogMessage): string => {
    const folderPath = getMessageKey(msg);
    const folderFullPath = path.join(config.storagePath, folderPath);

    let fullPath = this.filePathCache.get(folderPath);
    let fileNb = 0;

    if (!fullPath) {
      // si le dossier existe, sinon fileNb sera 0
      if (fs.existsSync(folderFullPath)) {
        // on récupère tous les fichiers du dossier
        const fileNames = fs.readdirSync(folderFullPath);

        const filesDatas = fileNames
          .filter(
            (fileName) => fileName.endsWith('.log') && fileName.includes(msg.dockerMessage?.containerId ?? 'no_id')
          ) // on ne garde que les fichiers de log pour le container actuel
          .map((fileName) => ({
            // on récupère les stats de chaque fichier
            stats: fs.statSync(path.join(folderFullPath, fileName)),
            fileName,
          }));

        const filesDatasFiltered = filesDatas.filter(
          //
          (file) => file.stats.size < config.maxLogFileSize
        ); // on ne garde que les fichiers qui ne sont pas trop gros

        if (filesDatasFiltered.length > 0) {
          const file = filesDatasFiltered[filesDatasFiltered.length - 1]!; // on prend le dernier fichier

          const [, nbStr] = path.basename(file.fileName, '.log').split('_');

          fileNb = Number(nbStr);
        } else {
          fileNb = filesDatas.length;
        }
      }

      fullPath = path.join(folderFullPath, `${msg.dockerMessage?.containerId ?? 'no_id'}_${fileNb}.log`);

      this.filePathCache.set(folderPath, fullPath);
    }

    return fullPath;
  };
}
