import { Table } from 'console-table-printer';
import express from 'express';
import fs from 'fs';
import generator from 'generate-password';
import path from 'path';

import { setVersionEndpoint } from '@libs/api-version';
import { Color, logger } from '@libs/logger';

import { archiveApi } from './archiveApi';
import { CifsApi } from './cifsApi';
import { mailApi } from './mailApi';
import { RsyncApi } from './rsyncApi';
import { SaveApi } from './saveApi';
import { config, getBackupConfig } from './utils/config';
import { sendBackupRecap, sendError } from './utils/ntfy';
import { OsUtils } from './utils/osUtils';
import { CifsDirectory, DirectoryToBackup, DirectoryType } from './utils/types';

logger.setAppName('autosaver');

let lastExecutionSuccess = false;
let executionInterval: NodeJS.Timeout | undefined = undefined;

const printRecapTable = (foldersToBackup: DirectoryToBackup[]) => {
  const table = new Table({
    columns: [
      { name: 'name', title: 'Folder name' },
      { name: 'filesNb', title: 'Nb files' },
      { name: 'size', title: 'Zip size' },
      { name: 'duration', title: 'Duration' },
    ],
  });

  for (const folderToBackup of foldersToBackup) {
    table.addRow(
      {
        name: folderToBackup.name,
        filesNb: folderToBackup.filesNb,
        size: folderToBackup.size !== undefined ? (folderToBackup.size / 1024 / 1024).toFixed(2) + ' MB' : '',
        duration: folderToBackup.duration !== undefined ? (folderToBackup.duration / 1000).toFixed(2) + ' s' : '',
      },
      {
        color: folderToBackup.success ? 'green' : 'red',
      }
    );
  }

  table.printTable();
};

const run = async () => {
  if (executionInterval) {
    logger.info('Autosaver already running');

    return;
  }

  const backupConfig = getBackupConfig();

  logger.info('BackupConfig : ', backupConfig);

  const getMountPath = (cifsDirectory: CifsDirectory) =>
    cifsDirectory.mountPath.startsWith('/')
      ? cifsDirectory.mountPath
      : `${backupConfig.backupPath}/${cifsDirectory.mountPath}`;

  logger.info('Backup script started');

  executionInterval = setInterval(async () => {
    logger.info('Backup script running');
    if (config.keepAliveUrl) {
      const response = await fetch(config.keepAliveUrl);

      const text = await response.text();

      logger.debug(`Keep alive : ${config.keepAliveUrl} => ${response.status} : ${text}`);
    }
  }, 1000 * 60);
  try {
    logger.info('Step 1 => Mounting rsync');
    if (backupConfig.rsync && backupConfig.rsync.type === DirectoryType.cifs) {
      logger.info('Mounting rsync');
      await CifsApi.mountCifsFolder(
        backupConfig.rsync.ip,
        backupConfig.rsync.user,
        backupConfig.rsync.password,
        backupConfig.rsync.hostPath,
        backupConfig.rsync.mountPath,
        backupConfig.rsync.port
      );
    } else {
      logger.info('Rsync is not a cifs directory');
    }

    logger.info('Step 2 => Mounting cifsDirectories');
    if (backupConfig.cifsDirectories && backupConfig.cifsDirectories.length > 0) {
      logger.info('Mounting cifsDirectories');
      for (const cifsDirectory of backupConfig.cifsDirectories) {
        await CifsApi.mountCifsFolder(
          cifsDirectory.ip,
          cifsDirectory.user,
          cifsDirectory.password,
          cifsDirectory.hostPath,
          getMountPath(cifsDirectory),
          cifsDirectory.port
        );
      }
    } else {
      logger.info('No cifsDirectories to mount');
    }

    logger.info('Step 3 => Listing directories to backup');
    const directoriesToBackup: DirectoryToBackup[] = fs
      .readdirSync(backupConfig.backupPath)
      .filter((file) => fs.lstatSync(path.join(backupConfig.backupPath, file)).isDirectory())
      .map((directory) => ({ name: directory, path: path.join(backupConfig.backupPath, directory) }));

    logger.info('Folders to backup : ', directoriesToBackup);

    logger.info('Step 4 => Mounting backupDest');
    const backupDestPath =
      backupConfig.backupDest.type === DirectoryType.local
        ? backupConfig.backupDest.path
        : backupConfig.backupDest.mountPath;
    if (backupConfig.backupDest.type === DirectoryType.cifs) {
      logger.info('Mounting backupDest');
      await CifsApi.mountCifsFolder(
        backupConfig.backupDest.ip,
        backupConfig.backupDest.user,
        backupConfig.backupDest.password,
        backupConfig.backupDest.hostPath,
        backupConfig.backupDest.mountPath,
        backupConfig.backupDest.port
      );
    } else {
      logger.info('BackupDest is not a cifs directory');
    }

    logger.info('BackupDestPath : ', backupDestPath);

    for (const directory of directoriesToBackup) {
      const startTime = Date.now();

      try {
        logger.info(`Backup of the directory ${directory.name}`);
        logger.info('Step 5 => Running rsync');
        if (backupConfig.rsync) {
          logger.info('Running rsync');

          const rsyncPath =
            backupConfig.rsync.type === DirectoryType.local ? backupConfig.rsync.path : backupConfig.rsync.mountPath;

          await RsyncApi.rsyncFolder(directory.path, rsyncPath);

          directory.path = path.join(rsyncPath, directory.name);
        } else {
          logger.info('Rsync is not enabled');
        }

        logger.info('Step 6 => Archiving');

        const archivePassword = generator.generate({ length: 12, numbers: true });

        logger.info(`Archiving ${directory.path}`);
        const { nbFilesArchived, archiveSize, archivePath } = await archiveApi.archiveFolder(
          directory.path,
          archivePassword
        );

        logger.info(`Archived ${nbFilesArchived} files (${archiveSize} bytes) to ${archivePath}`);

        logger.info('Step 7 => Copying archive to backupDest and sending mail');

        await SaveApi.cpFile(archivePath, backupDestPath);

        await OsUtils.rmFiles([archivePath]);

        await mailApi.sendFileInfos(archivePassword, archivePath, `${directory.name}`);

        logger.colored.info(Color.GREEN, `Backup of the directory ${directory.name} done`);

        directory.success = true;
        directory.filesNb = nbFilesArchived;
        directory.size = archiveSize;
      } catch (error: any) {
        logger.error(`Error during backup of ${directory.name}`);
        logger.error(error);
        mailApi.sendError(`code: ${error.code}, message: ${error.message}, error: ${error.error}`);
        directory.success = false;
      }

      directory.duration = Date.now() - startTime;
    }

    logger.info('Step 8 => Cleaning old directories');
    await SaveApi.cleanOldDirectories(backupDestPath);

    logger.info('Step 9 => Sending backup recap');
    sendBackupRecap(directoriesToBackup);
    printRecapTable(directoriesToBackup);
    lastExecutionSuccess = directoriesToBackup.filter((f) => !f.success).length === 0;

    logger.info('Step 10 => Unmounting cifsDirectories');
    if (backupConfig.cifsDirectories && backupConfig.cifsDirectories.length > 0) {
      logger.info('Unmounting cifsDirectories');
      for (const cifsDirectory of backupConfig.cifsDirectories) {
        await CifsApi.unmountSmbFolder(getMountPath(cifsDirectory));
      }
    } else {
      logger.info('No cifsDirectories to unmount');
    }

    logger.info('Step 11 => Unmounting backupDest');
    if (backupConfig.backupDest.type === DirectoryType.cifs) {
      logger.info('Unmounting backupDest');
      await CifsApi.unmountSmbFolder(backupConfig.backupDest.mountPath);
    } else {
      logger.info('BackupDest is not a cifs directory');
    }

    logger.info('Step 12 => Unmounting rsync');
    if (backupConfig.rsync && backupConfig.rsync.type === DirectoryType.cifs) {
      logger.info('Unmounting rsync');
      await CifsApi.unmountSmbFolder(backupConfig.rsync.mountPath);
    } else {
      logger.info('Rsync is not a cifs directory');
    }

    logger.info('Backup script finished');
  } catch (error: any) {
    logger.error('Error running autosaver');
    logger.error(error);

    mailApi.sendError(`code: ${error.code}, message: ${error.message}, error: ${error.error}`);
    sendError(`code: ${error.code}, message: ${error.message}, error: ${error.error}`);

    lastExecutionSuccess = false;
  }

  clearInterval(executionInterval);
  executionInterval = undefined;
};

const app = express();

setVersionEndpoint(app);

app.get('/', (req, res) => {
  res.status(200).send(executionInterval ? 'Running' : 'Stopped');
});

app.get('/last', (req, res) => {
  res.status(lastExecutionSuccess ? 200 : 500).send(lastExecutionSuccess ? 'OK' : 'KO');
});

app.get('/run', (req, res) => {
  if (executionInterval) {
    res.status(200).send('Autosave already running');
    logger.info('Autosave already running');
  } else {
    run();
    res.status(200).send('Autosave started');
  }
});

app.listen(config.serverPort, () => {
  logger.info('Server started on port ' + config.serverPort);
});
