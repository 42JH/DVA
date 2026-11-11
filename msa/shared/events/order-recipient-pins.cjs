"use strict";
const { validateReadScope } = require("./read-scope.cjs");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) && Object.keys(value).sort().join(",") === expected;
const id = (value) =>
  Number.isInteger(value) && value > 0 && value <= 2147483647;

function validateRecipientAddresses(value) {
  if (
    !Array.isArray(value) ||
    value.some(
      (address) =>
        !keys(
          address,
          "detailAddress,dongName,jibunAddress,name,phoneNumber,postalCode,roadAddress",
        ) ||
        Object.values(address).some(
          (field) =>
            typeof field !== "string" ||
            field.includes("\u0000") ||
            !field.isWellFormed(),
        ),
    )
  )
    throw new Error("Invalid recipient addresses");
}

function validateRecipientPins(value) {
  if (
    !Array.isArray(value) ||
    value.some(
      (pin) =>
        !keys(pin, "address,label,personalPinSeq") ||
        !id(pin.personalPinSeq) ||
        typeof pin.label !== "string" ||
        pin.label !== pin.address?.name,
    )
  )
    throw new Error("Invalid recipient pins");
  validateRecipientAddresses(value.map((pin) => pin.address));
  if (new Set(value.map((pin) => pin.personalPinSeq)).size !== value.length)
    throw new Error("Duplicate recipient pin");
}

function validateRecipientReceipt(value) {
  if (!keys(value, "eventId,payload"))
    throw new Error("Invalid recipient receipt");
  validateReadScope(value.eventId);
  const p = value.payload;
  if (
    !keys(p, "adminId,customerSeq,orderSeq,pins,requestId,writeEventId") ||
    !id(p.orderSeq) ||
    !id(p.customerSeq) ||
    !(p.adminId === null || id(p.adminId)) ||
    typeof p.requestId !== "string" ||
    p.requestId.length < 1 ||
    p.requestId.length > 128
  )
    throw new Error("Invalid recipient write");
  validateReadScope(p.writeEventId);
  validateRecipientPins(p.pins);
}

module.exports = {
  validateRecipientAddresses,
  validateRecipientPins,
  validateRecipientReceipt,
};
