const { createA2AServerRouter, getA2AInternalBaseURL } = require('@librechat/api');
const { configMiddleware } = require('~/server/middleware');
const {
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  checkRemoteAgentsFeature,
  checkAgentPathPermission,
} = require('./agents/middleware');

/** Serves agents over A2A at /api/a2a/agents/:agentId; off unless `a2aSettings.server.enabled`. */
module.exports = createA2AServerRouter({
  authenticate: [
    preAuthTenantMiddleware,
    requireRemoteAgentAuth,
    configMiddleware,
    checkRemoteAgentsFeature,
  ],
  checkAgentAccess: checkAgentPathPermission,
  serverDomain: process.env.DOMAIN_SERVER || 'http://localhost:3080',
  defaultInternalBaseURL: getA2AInternalBaseURL(process.env.HOST, Number(process.env.PORT) || 3080),
});
