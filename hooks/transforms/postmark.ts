/**
 * Postmark inbound email transform
 * Extracts MessageID, From, Subject, TextBody from Postmark webhook payload
 * and formats them for the agent with threading context
 */

export default async function transform(payload: any) {
  // DEBUG: Return raw payload to see what Postmark is sending
  return {
    message: `🔍 **DEBUG: Raw Postmark Payload**\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
  };
}
