const request = require("supertest");
const app = require("../src/app");

describe("Test the app", () => {
  describe("Test the app", () => {
    test("It should get contract by Id", async () => {
      const response = await request(app)
        .get("/contracts/" + 2)
        .set("profile_id", "1");
      expect(response.statusCode).toBe(200);
    });

    test("It should reject to see the contract", async () => {
      const response = await request(app)
        .get("/contracts/" + 5)
        .set("profile_id", "1");
      expect(response.statusCode).toBe(404);
    });
  });
});
