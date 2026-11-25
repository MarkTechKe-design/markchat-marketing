/** Seven Community-safe capability preview types. */
export type CapabilityId =
  | 'unified-inbox'
  | 'mpesa-stk'
  | 'markcopilot'
  | 'automation-routing'
  | 'contact-crm'
  | 'help-center'
  | 'analytics-webhooks';

/** Match the existing published feature CMS slugs to the seven Core homepage pillars. */
export const CAPABILITY_IMAGE_MATCHERS: Record<CapabilityId, RegExp> = {
  'unified-inbox': /shared.inbox|unified.inbox|team.inbox|collaborative/i,
  'mpesa-stk': /mpesa|m.pesa|checkout|payments/i,
  markcopilot: /markcopilot|ai.assist|agent.copilot/i,
  'automation-routing': /automation|routing|workflows/i,
  'contact-crm': /crm|contact|customer.profile/i,
  'help-center': /help.center|knowledge|self.service/i,
  'analytics-webhooks': /analytics|webhook|developer.api/i,
};
