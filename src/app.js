const express = require("express");
const bodyParser = require("body-parser");
const { sequelize } = require("./model");
const { Op } = require("sequelize");
const { getProfile } = require("./middleware/getProfile");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const contract = await Contract.findOne({
    where: {
      id,
      [Op.or]: [{ ContractorId: req.profile.id }, { ClientId: req.profile.id }],
    },
  });
  if (!contract) return res.status(404).end();
  res.json(contract);
});

/**
 * @returns a list of non terminated contracts belonging to a user
 */
app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const contracts = await Contract.findAll({
    where: {
      [Op.or]: [{ ContractorId: req.profile.id }, { ClientId: req.profile.id }],
      [Op.not]: [{ status: "terminated" }],
    },
  });
  if (!contracts) return res.status(404).end();
  res.json(contracts);
});

/**
 * @returns a list of all unpaid jobs for a user for active contracts only
 */
app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Job } = req.app.get("models");
  const { Contract } = req.app.get("models");
  // Using eager loading
  const unpaidJobs = await Job.findAll({
    where: { paid: { [Op.not]: true } },
    include: [
      {
        model: Contract,
        where: {
          [Op.or]: [
            { ContractorId: req.profile.id },
            { ClientId: req.profile.id },
          ],
          [Op.not]: [{ status: "terminated" }],
        },
      },
    ],
  });
  res.json(unpaidJobs);
});

const payForJob = async (contractor, client, job) => {
  const t = await sequelize.transaction();
  try {
    await client.increment("balance", { by: job.price }, { transaction: t });
    await contractor.decrement(
      "balance",
      { by: job.price },
      { transaction: t }
    );
    job.set({ paid: true }, { transaction: t });
    await job.save();
    await t.commit();
    return true;
  } catch (error) {
    await t.rollback();
    return false;
  }
};

/**
 * @returns The Pay for a job, a client can only pay if his balance >= the amount to pay.
 * The amount should be moved from the client's balance to the contractor balance.
 */
app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { Job } = req.app.get("models");
  const { job_id } = req.params;
  if (!job_id) return res.status(404).end("Job Id not provided");
  const job = await Job.findByPk(job_id);
  // Using lazy loading
  const contract = await job.getContract();
  if (
    contract.ContractorId !== req.profile.id &&
    contract.ClientId !== req.profile.id
  )
    return res.status(401).end("Not authorized to see this contract");
  if (contract.status !== "in_progress")
    return res.status(409).end("Contract is not in progress");
  if (job.paid) return res.status(409).end("job is already paid");
  const contractor = await contract.getContractor();
  if (job.price > contractor.balance)
    return res
      .status(409)
      .end("Not enough money in balance to pay for this job");
  const client = await contract.getClient();
  if (!payForJob(contractor, client, job))
    return res.status(500).end("Error paying job");

  res.status(200).end("Job succesfully paid");
});

/**
 * Deposits money into the the the balance of a client,
 * a client can't deposit more than 25% his total of jobs to pay. (at the deposit moment)
 */
app.post("/balances/deposit/:userId", async (req, res) => {
  const { Profile } = req.app.get("models");
  const { Contract } = req.app.get("models");
  const { Job } = req.app.get("models");
  const { userId } = req.params;
  const amountToDeposit = req.body.amount;
  if (!amountToDeposit)
    return res.status(404).end("Amount to deposit not provided");
  const client = await Profile.findOne({
    where: { id: userId, type: "client" },
    include: [
      {
        model: Contract,
        as: "Client",
        where: {
          [Op.not]: [{ status: "terminated" }],
        },
        include: {
          model: Job,
        },
      },
    ],
  });
  if (!client) return res.status(404).end("Client not found");
  const contracts = await client.Client;
  const totalAmountJobs = contracts
    .flatMap((contract) => contract.Jobs.map((job) => job.price))
    .reduce((a, b) => a + b);
  if (amountToDeposit > totalAmountJobs * 0.25)
    return res
      .status(409)
      .end("You may not deposit more than 25% of all jobs to be charged.");
  const result = await client.increment("balance", { by: amountToDeposit });
  return res.json(result);
});

/**
 * @returns the profession that earned the most money (sum of jobs paid)
 * for any contactor that worked in the query time range
 */
app.get("/admin/best-profession", async (req, res) => {
  const startDate = req.query.start;
  const endDate = req.query.end;
  if (!startDate || !endDate)
    return res.status(400).end("Start & End dates not provided");
  const { Profile } = req.app.get("models");
  const { Contract } = req.app.get("models");
  const { Job } = req.app.get("models");
  const bestClient = await Profile.findAll({
    attributes: {
      include: [
        [sequelize.fn("MAX", sequelize.col("Client.Jobs.price")), "sum_paid"],
      ],
    },
    where: {
      type: "client",
      createdAt: { [Op.between]: [startDate, endDate] },
    },
    include: [
      {
        model: Contract,
        as: "Client",
        include: { model: Job, where: { paid: true } },
      },
    ],
  });
  if (!bestClient)
    return res.status(400).end("Profession not found between dates");
  return res.json(bestClient[0].profession);
});

/**
 * @returns the clients the paid the most for jobs in the query time period.
 * limit query parameter should be applied, default limit is 2
 */
app.get("/admin/best-clients", async (req, res) => {
  const startDate = req.query.start;
  const endDate = req.query.end;
  const limit = req.query.limit ?? 2;
  if (!startDate || !endDate)
    return res.status(400).end("Start & End dates not provided");
  const { Profile } = req.app.get("models");
  const { Contract } = req.app.get("models");
  const { Job } = req.app.get("models");
  const bestClient = await Profile.findAll({
    attributes: [
      [sequelize.literal("Profile.id"), "id"],
      [sequelize.literal("firstName || ' ' || lastName"), "full_name"],
      [sequelize.fn("SUM", sequelize.col("Client.Jobs.price")), "paid"],
    ],
    where: {
      type: "client",
    },
    include: [
      {
        model: Contract,
        as: "Client",
        attributes: [],
        include: {
          model: Job,
          where: {
            paid: true,
            paymentDate: { [Op.between]: [startDate, endDate] },
          },
          attributes: [],
        },
      },
    ],
    group: ["Profile.id"],
    order: sequelize.literal(`paid DESC LIMIT ${limit}`),
  });
  return res.json(bestClient);
});

module.exports = app;
