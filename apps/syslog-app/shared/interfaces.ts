export interface SyslogMessage {
  date: Date;
  host: string;
  dockerMessage?: DockerMessage;
  message: string;
  protocol: string;
}

export interface DockerMessage {
  date: Date;
  message: string;
  containerName: string;
  containerId: string;
}
