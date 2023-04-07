const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const Web3 = require('web3');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
// const redis = require('redis');
// const cache = require('express-redis-cache')({ client: redis.createClient() });
const LRU = require('lru-cache');
require('dotenv').config();


const { MongoClient } = require('mongodb');
const { ObjectId } = require('mongodb');

// Import the necessary contracts and utilities
const Pool = require('./DepositGateway.json'); // Import the Pool contract ABI
const ThirdPartyContract = require('./BiconomyGasTank.json'); // Import the ThirdPartyContract ABI

const app = express();
app.use(express.json());

// Replace 'your-frontend-domain.com' with your actual domain
// const corsOptions = {
//   origin: 'https://juccipay.vercel.app',
//   optionsSuccessStatus: 200,
// };
app.use(cors());
app.use(helmet());

// Debug

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client = new MongoClient(uri);

// Web3 section

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_MUMBAI_RPC_URL || "https://polygon-mumbai.g.alchemy.com/v2/hsCd_Sd5bs_1GpGW3tbtLcQcLrPmZXB-");
const web3 = new Web3(process.env.ALCHEMY_MUMBAI_RPC_URL || "https://polygon-mumbai.g.alchemy.com/v2/hsCd_Sd5bs_1GpGW3tbtLcQcLrPmZXB-");

const poolContractAddress = process.env.DEPOSIT_GATEWAY_CONTRACT_ADDRESS || '0xF8A694157F6C8ddA0b5243554bCA06e76Ec15D2A';
const thirdPartyContractAddress = process.env.BICONOMY_GAS_TANK_CONTRACT_ADDRESS || '0x295609fDCa9C61D0362DA36020E02fdc0164D86b';

const poolContract = new ethers.Contract(poolContractAddress, Pool, provider);
const thirdPartyContract = new ethers.Contract(thirdPartyContractAddress, ThirdPartyContract, provider);

// Replace these with your private key
const privateKey = process.env.PRIVATE_KEY;
const wallet = new ethers.Wallet(privateKey, provider);

const dappBalanceCache = new LRU({ max: 100, maxAge: 1000 * 60 * 5 }); // Cache up to 100 items for 5 minutes

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});



// Endpoints
app.get('/api/projects', async (req, res) => {
  await client.connect();
  const projects = await client.db('myDatabase').collection('projects').find().toArray();

  const modifiedProjects = projects.map(project => {
    return {
      ...project,
      apiKey: "hidden"
    };
  });

  res.json(modifiedProjects);
});

app.post('/api/projects', async (req, res) => {
  try {
    await client.connect();
    // should encrypt apiKey before sending over here
    const result = await client.db('myDatabase').collection('projects').insertOne(req.body);
    console.log("result:", result);
    res.json({ _id: result.insertedId });
  } catch (error) {
    console.error("Error in /api/projects:", error);
    res.status(500).json({ error: "An error occurred while processing the request." });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  const projectId = req.params.id;
  await client.connect();
  const project = await client.db('myDatabase').collection('projects').findOne({ _id: new ObjectId(projectId)});

  if (!project) {
    res.status(404).send('Project not found');
    return;
  }

  const decryptedApiKey = project.apiKey;
  let dappBalance = dappBalanceCache.get(decryptedApiKey);

  if (dappBalance === undefined) {
    // Read the dapp balance from the DappGasTank Contract if it's not in the cache
    dappBalance = await thirdPartyContract.dappBalances(decryptedApiKey);
    dappBalanceCache.set(decryptedApiKey, dappBalance);
  }

  project.dappBalance = dappBalance.toString(); // Add the dapp balance to the project object
  project.apiKey = ""

  res.json(project);
});

app.post('/api/projects/:id/deposit', async (req, res) => {
  const projectId = req.params.id;
  await client.connect();
  const project = await client.db('myDatabase').collection('projects').findOne({ _id: new ObjectId(projectId) });
  if (!project) {
    res.status(404).send('Project not found');
    return;
  }

  try {
    const { amount, signature, userAddress } = req.body;

    //convert the amount string back to BigNUmber
    const weiAmount = ethers.BigNumber.from(amount)
    // Verify the signed message
    const message = ethers.utils.solidityKeccak256(['uint256'], [weiAmount]);
    const hashedMessage = ethers.utils.arrayify(message);
    const recoveredAddress = ethers.utils.verifyMessage(hashedMessage, signature);


    const normalizedUserAddress = ethers.utils.getAddress(userAddress);
    const normalizedRecoveredAddress = ethers.utils.getAddress(recoveredAddress);
    
    if (normalizedRecoveredAddress !== normalizedUserAddress) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    let gasPrice = await provider.getGasPrice();
    console.log(gasPrice)
    let nonce = await wallet.getTransactionCount();
    console.log(nonce)

    // Unlock the user's funds in the Pool contract
    const unlockFundsData = poolContract.interface.encodeFunctionData('unlockFunds', [userAddress, weiAmount]);
    const unlockFundsTx = {
      to: poolContractAddress,
      data: unlockFundsData,
      value: 0,
      chainId: 80001, // Add the chainId here
      nonce,
      gasPrice: gasPrice.mul(3),
      gasLimit: 500000, // You can adjust this value if needed
    };

    console.log("Wallet address:", wallet.address);
    const contractOwner = await poolContract.owner();
    console.log("Contract owner:", contractOwner);

    const signedUnlockFundsTx = await wallet.signTransaction(unlockFundsTx);
    const unlockFundsTxReceipt = await provider.sendTransaction(signedUnlockFundsTx);

    // Wait for the transaction to be mined
    await unlockFundsTxReceipt.wait();

    console.log('done unlocked');

    gasPrice = await provider.getGasPrice();
    nonce = await wallet.getTransactionCount();

    // should use cryptographic stuff in the future
    const decryptedApiKey = project.apiKey;

    // Send the deposit to the ThirdPartyContract
    const depositData = thirdPartyContract.interface.encodeFunctionData('depositFor', [decryptedApiKey]);
    const depositTx = {
      to: thirdPartyContractAddress,
      data: depositData,
      value: weiAmount,
      chainId: 80001,
      nonce,
      gasPrice: gasPrice.mul(3),
      gasLimit: 500000, // You can adjust this value if needed
    };

    const signedDepositTx = await wallet.signTransaction(depositTx);
    const depositTxReceipt = await provider.sendTransaction(signedDepositTx);

    // Wait for the transaction to be mined
    await depositTxReceipt.wait();

    console.log('done deposit gastank')


    // Respond with a success message
    res.status(200).json({ message: 'Deposit successful!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ message: error.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});