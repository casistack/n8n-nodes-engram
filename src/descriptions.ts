import type { INodeProperties } from 'n8n-workflow';

export const sessionIdOption: INodeProperties = {
  displayName: 'Session ID',
  name: 'sessionIdType',
  type: 'options',
  options: [
    {
      // eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
      name: 'Take from previous node automatically',
      value: 'fromInput',
      description: 'Looks for an input field called sessionId',
    },
    {
      // eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
      name: 'Define below',
      value: 'customKey',
      description: 'Use an expression to reference data in previous nodes or enter static text',
    },
  ],
  default: 'fromInput',
};

export const sessionKeyProperty: INodeProperties = {
  displayName: 'Key',
  name: 'sessionKey',
  type: 'string',
  default: '',
  description: 'The key to use to store session ID in the memory',
  displayOptions: {
    show: {
      sessionIdType: ['customKey'],
    },
  },
};

export const contextWindowLengthProperty: INodeProperties = {
  displayName: 'Context Window Length',
  name: 'contextWindowLength',
  type: 'number',
  default: 5,
  hint: 'How many past interactions the model receives as context',
};

export const customStoragePathProperty: INodeProperties = {
  displayName: 'Custom Storage Path',
  name: 'customStoragePath',
  type: 'string',
  default: '',
  placeholder: '/data/engram',
  // eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
  description:
    'Custom directory for graph data files. Leave empty to use the default n8n storage directory (~/.n8n/storage/) which inherits correct permissions automatically. Only set this for custom Docker volume mounts — you are responsible for ensuring the n8n process user has read/write access to the directory.',
  displayOptions: {
    show: {
      backend: ['embedded'],
    },
  },
};
