import jsYaml from 'js-yaml';

import { AppData, Host } from './interfaces';

export const parseTraefikLabels = (
  host: Host,
  labels: { [key: string]: string },
  data: AppData
): { services: any; routers: any } => {
  const proxy = data.proxies.find((proxy) => proxy.sourceIP === host.ip);
  const serverIp = proxy?.activated ? proxy.destIP : host.ip;

  const services: any = {};

  const routers: any = {};

  for (const [key, value] of Object.entries(labels)) {
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();

    try {
      if (trimmedKey.startsWith('my-traefik.http.services')) {
        const serviceName = trimmedKey.split('.')[3];

        if (serviceName) {
          services[serviceName] = {};
          if (trimmedKey.endsWith('port')) {
            services[serviceName].loadBalancer = {
              servers: [{ url: `http://${serverIp}:{{env "${trimmedValue}" }}/` }],
            };
          }
        }
      }

      if (trimmedKey.startsWith('my-traefik.http.routers')) {
        console.log('key', trimmedKey, 'value', trimmedValue);
        const splitKey = trimmedKey.split('.');
        const routerName = splitKey[3];

        if (routerName) {
          if (!routers[routerName]) routers[routerName] = {};

          if (trimmedKey.endsWith('rule')) {
            console.log('rule', trimmedValue);
            routers[routerName].rule = trimmedValue;
          }

          if (trimmedKey.endsWith('entrypoints')) {
            routers[routerName].entryPoints = trimmedValue.split(',');
          }

          if (trimmedKey.endsWith('service')) {
            routers[routerName].service = trimmedValue;
          }

          if (trimmedKey.endsWith('middlewares')) {
            routers[routerName].middlewares = trimmedValue.split(',');
          }

          if (splitKey[4] === 'tls') {
            if (!routers[routerName].tls) {
              routers[routerName].tls = {};
            }

            routers[routerName].tls[splitKey[5]!] = trimmedValue;
          }
        }
      }

      if (trimmedKey === 'traefik-conf.port') {
        const serviceName = labels['traefik-conf.name'] || labels['com.docker.compose.service'] || '';

        const routerName = `${host.name}_${serviceName}`.toLowerCase();

        routers[routerName] = {
          entryPoints: 'http',
          service: serviceName,
          rule: `Host(\`${serviceName}.${host.name.toLowerCase()}.home\`)`,
        };

        services[serviceName] = {
          loadBalancer: {
            servers: [
              {
                url: `http://${serverIp}:{{env "${trimmedValue}" }}/`,
              },
            ],
          },
        };
      }
    } catch (error) {
      console.error('Error while parsing traefik labels : ', error);
    }
  }

  return { services, routers };
};
