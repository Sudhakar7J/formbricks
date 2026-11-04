import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSetupCheckoutSession, getCardOnlyCheckoutParams } from "./create-setup-checkout-session";

const mocks = vi.hoisted(() => ({
  subscriptionsRetrieve: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: {
    STRIPE_SECRET_KEY: "sk_test_123",
  },
}));

vi.mock("stripe", () => ({
  default: class MockStripe {
    subscriptions = {
      retrieve: mocks.subscriptionsRetrieve,
    };
    checkout = {
      sessions: {
        create: mocks.checkoutSessionsCreate,
      },
    };
  },
}));

describe("createSetupCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscriptionsRetrieve.mockResolvedValue({ currency: "usd" });
    mocks.checkoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.test/setup" });
  });

  afterEach(() => {
    vi.doUnmock("@/lib/constants");
    vi.resetModules();
  });

  test("creates payment-only setup checkout without upgrade metadata", async () => {
    const url = await createSetupCheckoutSession(
      "cus_1",
      "sub_1",
      "https://app.formbricks.com/workspaces/ws_1/settings/organization/billing",
      "org_1"
    );

    expect(url).toBe("https://checkout.stripe.test/setup");
    expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          "https://app.formbricks.com/workspaces/ws_1/settings/organization/billing?checkout_success=1",
        metadata: {
          organizationId: "org_1",
          subscriptionId: "sub_1",
        },
      })
    );
  });

  test("creates setup checkout with upgrade metadata and pending success flag", async () => {
    await createSetupCheckoutSession(
      "cus_1",
      "sub_1",
      "https://app.formbricks.com/workspaces/ws_1/settings/organization/billing",
      "org_1",
      {
        targetPlan: "scale",
        targetInterval: "monthly",
      }
    );

    expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          "https://app.formbricks.com/workspaces/ws_1/settings/organization/billing?checkout_success=1&upgrade_pending=1&session_id={CHECKOUT_SESSION_ID}",
        metadata: {
          organizationId: "org_1",
          subscriptionId: "sub_1",
          targetPlan: "scale",
          targetInterval: "monthly",
        },
      })
    );
  });

  // ENG-3370: the upgrade is confirmed with confirmCardPayment and may replace a legacy EUR subscription
  // with a USD one, so the checkout must not offer a method (e.g. SEPA for EUR) that can't pay it.
  test("restricts an upgrade checkout to cards, even for a EUR subscription", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue({ currency: "eur" });

    await createSetupCheckoutSession("cus_1", "sub_1", "https://app.formbricks.com/billing", "org_1", {
      targetPlan: "pro",
      targetInterval: "monthly",
    });

    expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_types: ["card"] })
    );
    expect(mocks.checkoutSessionsCreate.mock.calls[0][0]).not.toHaveProperty("allowed_payment_method_types");
  });

  test("leaves a card-only (no upgrade) checkout on the account's payment methods", async () => {
    await createSetupCheckoutSession("cus_1", "sub_1", "https://app.formbricks.com/billing", "org_1");

    expect(mocks.checkoutSessionsCreate.mock.calls[0][0]).not.toHaveProperty("payment_method_types");
    expect(mocks.checkoutSessionsCreate.mock.calls[0][0]).not.toHaveProperty("allowed_payment_method_types");
  });

  test("sends only allowed_payment_method_types when pinned to the endive API", async () => {
    vi.resetModules();
    vi.doMock("@/lib/constants", () => ({ STRIPE_API_VERSION: "2026-09-30.endive" }));

    const { createSetupCheckoutSession: createEndiveSetupCheckoutSession } =
      await import("./create-setup-checkout-session");

    await createEndiveSetupCheckoutSession("cus_1", "sub_1", "https://app.formbricks.com/billing", "org_1", {
      targetPlan: "pro",
      targetInterval: "monthly",
    });

    expect(mocks.checkoutSessionsCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ allowed_payment_method_types: ["card"] })
    );
    expect(mocks.checkoutSessionsCreate.mock.calls[0][0]).not.toHaveProperty("payment_method_types");
  });
});

describe("getCardOnlyCheckoutParams", () => {
  test("keeps the pinned pre-endive API on payment_method_types", () => {
    expect(getCardOnlyCheckoutParams("2026-02-25.clover")).toEqual({
      payment_method_types: ["card"],
    });
  });

  test("uses allowed_payment_method_types from the endive API onward", () => {
    const params = getCardOnlyCheckoutParams("2026-09-30.endive");

    expect(params).toEqual({ allowed_payment_method_types: ["card"] });
    expect(params).not.toHaveProperty("payment_method_types");
    expect(getCardOnlyCheckoutParams("2026-10-01.later")).toEqual({
      allowed_payment_method_types: ["card"],
    });
  });
});
