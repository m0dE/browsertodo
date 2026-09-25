/**
 * Error answers of the Anthropic API and the browsertodo API (/v1/ai/*), read
 * one way for Messages requests and for Jev.
 */
import { z } from "zod";
import { OUT_OF_CREDIT, OutOfCreditError as OutOfCreditBody } from "@browsertodo/shared";

/** A hosted-AI request was refused with 402: the account has no usage credit left. */
export class OutOfCreditError extends Error {
  constructor(
    message: string,
    readonly topupUrl?: string,
  ) {
    super(message);
    this.name = "OutOfCreditError";
  }
}

/** The response body as JSON, or undefined when it is not JSON. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The 402 body's fields, read leniently: a body without them still means "out of credit". */
const CreditBody = OutOfCreditBody.pick({ message: true, topupUrl: true }).partial();

/** A 402 answer as an error: OUT_OF_CREDIT, the server's explanation, and the top-up link. */
export function outOfCreditError(body: string): OutOfCreditError {
  const parsed = CreditBody.safeParse(parseJsonBody(body));
  const { message, topupUrl } = parsed.success ? parsed.data : {};
  return new OutOfCreditError(message ? `${OUT_OF_CREDIT}: ${message}` : OUT_OF_CREDIT, topupUrl || undefined);
}

/** The browsertodo API answers { error: "code or text", message? }; Anthropic answers { error: { type, message } }. */
const ErrorBody = z.object({
  error: z.union([z.string(), z.object({ type: z.string().optional(), message: z.string().optional() })]),
  message: z.string().optional(),
});

/** What an error answer says, from either API's error body, else the start of the text. */
export function errorDetail(body: string, maxChars = 300): string {
  const parsed = ErrorBody.safeParse(parseJsonBody(body));
  if (parsed.success) {
    const { error, message } = parsed.data;
    if (typeof error === "string") return message ? `${error}: ${message}` : error;
    if (error.message) return `${error.type ? `${error.type}: ` : ""}${error.message}`;
  }
  return body.slice(0, maxChars);
}
