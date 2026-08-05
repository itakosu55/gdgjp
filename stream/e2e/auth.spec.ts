import { expect, test } from "@playwright/test";

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the landing page is public", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "配信・音響機材の構成" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  // Checked at the redirect rather than by following it: the sign-in hop ends
  // at the IdP, which this suite deliberately never starts.
  for (const path of ["/devices", "/models", "/events"]) {
    test(`${path} redirects to sign in`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers().location).toContain("/signin");
    });
  }
});

test.describe("signed in", () => {
  test("the account menu is shown instead of the sign-in link", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  });

  test("the protected screens open", async ({ page }) => {
    await page.goto("/devices");
    await expect(page.getByRole("heading", { name: "機材台帳" })).toBeVisible();
  });
});
