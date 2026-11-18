"use strict";
const { validateEvent } = require("./index.cjs");
const { validateReadScope } = require("./read-scope.cjs");
const { privateAddress } = require("./call-event-reference.cjs");
const { ScopeResponseError } = require("./call-scope.cjs");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) && Object.keys(value).sort().join(",") === expected;
const id = (value) =>
  Number.isInteger(value) && value > 0 && value <= 2147483647;

function validateCardCallScope(event, source) {
  validateEvent(event);
  validateReadScope(event.eventId);
  const field =
    source === "customer" ? "customerAddress" : "consultationAddress";
  const fields =
    source === "customer" && event.payload.registration === true
      ? "customerAddress,registration"
      : field;
  if (
    !["customer", "consultation"].includes(source) ||
    event.source !== source ||
    event.eventType !== "PaymentCardCallScopeRequested" ||
    !keys(event.payload, fields) ||
    !(event.payload[field] === null || privateAddress(event.payload[field]))
  )
    throw new Error("Invalid card call scope");
}

function validateCardCaller(event) {
  validateEvent(event);
  if (
    event.source !== "customer" ||
    event.eventType !== "PaymentCardCallerRead" ||
    !keys(event.payload, "callSessionSeq,scopeId") ||
    !id(event.payload.callSessionSeq)
  )
    throw new Error("Invalid card caller");
  validateReadScope(event.payload.scopeId);
}

async function requestCardCaller(url, token, event) {
  validateCardCaller(event);
  const endpoint = new URL(url);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    typeof token !== "string" ||
    !/^[\x21-\x7e]{32,256}$/.test(token)
  )
    throw new Error("Invalid card caller transport");
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: null,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    await response.body?.cancel();
    throw new Error("Invalid card caller response type");
  }
  const parts = [];
  try {
    for await (const part of response.body ?? []) parts.push(part);
  } finally {
    await response.body?.cancel();
  }
  const result = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
  );
  if (response.status !== 200) {
    const error = result?.error;
    if (
      [403, 404, 409, 500, 503].includes(response.status) &&
      keys(error, "code,details,message") &&
      [
        "FORBIDDEN",
        "NOT_FOUND",
        "INVALID_STATE",
        "INTERNAL_ERROR",
        "DEPENDENCY_UNAVAILABLE",
      ].includes(error.code) &&
      typeof error.message === "string" &&
      Array.isArray(error.details) &&
      error.details.every(
        (detail) =>
          keys(detail, "field,reason") &&
          typeof detail.field === "string" &&
          typeof detail.reason === "string",
      )
    )
      throw new ScopeResponseError(response.status, error);
    throw new Error("Invalid card caller failure");
  }
  if (
    !keys(result, "eventId,payload,status") ||
    result.eventId !== event.eventId ||
    result.status !== "processed" ||
    !keys(result.payload, "customerSeq,endedAt,phone") ||
    typeof result.payload.phone !== "string" ||
    !result.payload.phone ||
    result.payload.endedAt !== null ||
    !(result.payload.customerSeq === null || id(result.payload.customerSeq))
  )
    throw new Error("Invalid card caller acknowledgement");
  return result.payload;
}

module.exports = {
  validateCardCallScope,
  validateCardCaller,
  requestCardCaller,
};
