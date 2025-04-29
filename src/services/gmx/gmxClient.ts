import { AbstractDexClient } from '../abstractDexClient';
import { doubleSizeIfReverseOrder, getStrategiesDB } from '../../helper';
import {
	gmxOrderParams,
	AlertObject,
	GmxPositionResponse,
	OrderResult
} from '../../types';
import config = require('config');
import 'dotenv/config';
import { ExchangeRouterAbi } from './abi/exchangeRounter';
import { ethers } from 'ethers';

import { erc20Abi } from './abi/erc20';
import { ReaderAbi } from './abi/reader';
import {
	BASE_DECIMAL,
	gmxOrderType,
	gmxTokenDecimals,
	gmxTokenAddresses,
	gmxGMTokenMap
} from './constants';
import { _sleep } from '../../helper';
import axios from 'axios';
import { dataStoreAbi } from './abi/dataStore';

const exchangeRounter = '0x900173A66dbD345006C51fA35fA3aB760FcD843b';
const transferRouter = '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6';
const reader = '0xf60becbba223eea9495da3f606753867ec10d139';
const dataStore = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';

const orderVault = '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5';
const usdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const usdcDecimal = 6;
const myReferralCode =
	'0x74765f616c6572745f636f6e6e6563746f720000000000000000000000000000';

export class GmxClient extends AbstractDexClient {
	private signer: ethers.Wallet;
	constructor() {
		super();
		this.signer = this.getClient();
	}

	getClient = () => {
		if (!process.env.GMX_PRIVATE_KEY) {
			console.log('GMX_PRIVATE_KEY for GMX is not set as environment variable');
			return;
		}

		// TODO: set 1x leverage by default
		if (!process.env.GMX_LEVERAGE) {
			console.log('GMX_LEVERAGE for GMX is not set as environment variable');
			return;
		}

		const GMX_LEVERAGE = Number(process.env.GMX_LEVERAGE);

		if (GMX_LEVERAGE < 0.1 || GMX_LEVERAGE > 100) {
			console.error('GMX_LEVERAGE must be between 1.1 and 100');
			return;
		}

		const rpcUrl: string = config.get('GMX.Network.host');
		const provider = ethers.getDefaultProvider(rpcUrl);
		return new ethers.Wallet('0x' + process.env.GMX_PRIVATE_KEY, provider);
	};

	getIsAccountReady = async () => {
		try {
			if (!this.signer) return false;
			const balance = await this.signer.getBalance();
			console.log(
				'GMX(Arbitrum) ETH balance: ',
				ethers.utils.formatEther(balance)
			);

			console.log('GMX_LEVERAGE: ' + process.env.GMX_LEVERAGE);

			return Number(balance) > 0;
		} catch (error) {
			console.error(error);
		}
	};

	buildOrderParams = async (alertMessage: AlertObject) => {
		const isLong = alertMessage.order == 'buy' ? true : false;

		let orderSize: number;

		// TODO: implement sizeByLeverage for GMX
		if (alertMessage.size) {
			// convert to USD size
			orderSize = Math.floor(
				Number(alertMessage.size) * Number(alertMessage.price)
			);
		} else if (alertMessage.sizeUsd) {
			orderSize = alertMessage.sizeUsd;
		} else {
			console.error('Order size is not specified in alert message');
			return;
		}

		orderSize = doubleSizeIfReverseOrder(alertMessage, orderSize);

		// TODO: send order with minimum amount instead of throwing error
		if (orderSize < 2) {
			console.error('Order size must be greater than 2 USD');
			return;
		}

		const market = gmxGMTokenMap.get(alertMessage.market);
		if (!market) {
			console.error(`Market: ${alertMessage.market} is not supported`);
			return;
		}

		if (alertMessage.collateral) {
			const collateral = gmxTokenDecimals.get(alertMessage.collateral);
			if (!collateral) {
				console.error(
					`Collateral: ${alertMessage.collateral} is not supported/found`
				);
				return;
			}
		}

		// TODO: set USDC collateral by default
		const orderParams: gmxOrderParams = {
			marketAddress: market,
			isLong,
			sizeUsd: orderSize,
			price: alertMessage.price,
			collateral: alertMessage.collateral
		};
		console.log('orderParams for GMX', orderParams);
		return orderParams;
	};

	placeOrder = async (alertMessage: AlertObject) => {
		const orderParams = await this.buildOrderParams(alertMessage);
		try {
			const orderResult = await this.createOrder(orderParams);
			await this.exportOrder(
				'Gmx',
				alertMessage.strategy,
				orderResult,
				alertMessage.price,
				alertMessage.market
			);
		} catch (error) {
			console.error(error);
			return;
		}
	};

	createOrder = async (orderParams: gmxOrderParams) => {
		const gmxContract = new ethers.Contract(
			exchangeRounter,
			ExchangeRouterAbi,
			this.signer
		);

		const positionResponse = await this.getOrderTypeAndPosition(
			orderParams.marketAddress,
			orderParams.isLong
		);
		const orderType = positionResponse.orderType;

		let adustedSizeUsd = orderParams.sizeUsd;

		let initialCollateralDeltaAmount = ethers.BigNumber.from(0);
		if (positionResponse.orderType === gmxOrderType.MarketDecrease) {
			let withdrawAmount =
				positionResponse.collateralAmount *
				(orderParams.sizeUsd / positionResponse.positionSizeUsd);
			// when full close
			if (positionResponse.positionSizeUsd < orderParams.sizeUsd) {
				adustedSizeUsd = positionResponse.positionSizeUsd;
				withdrawAmount = positionResponse.collateralAmount;
			}
			withdrawAmount = Math.floor(withdrawAmount * 10000) / 10000;

			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			initialCollateralDeltaAmount = ethers.utils.parseUnits(
				String(withdrawAmount),
				usdcDecimal
			);
		}

		const decreasePositionSwapType =
			positionResponse.orderType === gmxOrderType.MarketIncrease ? 0 : 1;
		const sizeDeltaUsd = ethers.utils.parseUnits(
			String(adustedSizeUsd),
			BASE_DECIMAL
		);
		const acceptablePrice = this.getAcceptablePrice(
			orderParams.isLong,
			orderParams.price
		);

		const executionFee = await this.getExecutionFee(positionResponse.orderType);

		const createOrderParam = {
			addresses: {
				receiver: this.signer.address,
				cancellationReceiver: this.signer.address,
				callbackContract: '0x0000000000000000000000000000000000000000',
				uiFeeReceiver: '0x0000000000000000000000000000000000000000',
				market: orderParams.marketAddress,
				initialCollateralToken: orderParams.collateral
					? gmxTokenAddresses.get(orderParams.collateral)
					: usdc,
				swapPath: []
			},
			numbers: {
				sizeDeltaUsd,
				initialCollateralDeltaAmount,
				triggerPrice: 0,
				acceptablePrice,
				executionFee,
				callbackGasLimit: 0,
				minOutputAmount: 0,
				validFromTime: 0
			},
			orderType,
			decreasePositionSwapType,
			isLong: positionResponse.hasLongPosition ?? orderParams.isLong,
			shouldUnwrapNativeToken: false,
			autoCancel: false,
			referralCode: myReferralCode
			// 0x0000000000000000000000000000000000000000000000000000000000000000
		};

		console.log('createOrderParam: ', createOrderParam);

		const createOrderData = gmxContract.interface.encodeFunctionData(
			'createOrder',
			[createOrderParam]
		);

		// construct multiCall
		const multiCallParams = [
			gmxContract.interface.encodeFunctionData('sendWnt', [
				orderVault,
				executionFee
			])
		];

		// when MarketIncrease, calculate collateral amount, approve, sentToken
		if (orderType == gmxOrderType.MarketIncrease) {
			const sendUsdAmount =
				orderParams.sizeUsd / Number(process.env.GMX_LEVERAGE);
			if (sendUsdAmount < 2) throw Error("Can't send less than 2 USD");

			const collateralPrice = await this.getCollateralPrice(
				orderParams.collateral
			);
			const sendAmount = orderParams.collateral
				? sendUsdAmount / collateralPrice
				: sendUsdAmount;

			const decimal = orderParams.collateral
				? gmxTokenDecimals.get(orderParams.collateral)
				: usdcDecimal;

			const scaler = Math.pow(10, decimal);

			const sendCollateralAmount = Math.ceil(sendAmount * scaler) / scaler;

			const parsedSendAmount = ethers.utils.parseUnits(
				sendCollateralAmount.toString(),
				decimal
			);

			await this.checkAndApprove(parsedSendAmount, orderParams.collateral);

			multiCallParams.push(
				gmxContract.interface.encodeFunctionData('sendTokens', [
					orderParams.collateral
						? gmxTokenAddresses.get(orderParams.collateral)
						: usdc,
					orderVault,
					parsedSendAmount
				])
			);
		}

		multiCallParams.push(createOrderData);
		const gasPrice = this.getGasPrice();

		let attempt = 0;
		let tx;
		while (attempt < 3) {
			try {
				tx = await gmxContract.multicall(multiCallParams, {
					value: executionFee,
					gasPrice: gasPrice
				});
				break;
			} catch (error) {
				console.error(error);
				attempt++;
				if (attempt >= 3) throw error;
				console.log(`Retrying transaction... Attempt ${attempt}/3`);
			}
		}

		console.log('Order created successfully:', tx);

		const receipt = await tx.wait();
		console.log('tx receipt', receipt);

		// if it's a decrease order, create another order with rest size
		if (
			orderType == gmxOrderType.MarketDecrease &&
			positionResponse.positionSizeUsd &&
			positionResponse.positionSizeUsd + 2 < orderParams.sizeUsd
		) {
			// wait actual first order is executed
			await _sleep(20000);
			const restSizeUsd =
				orderParams.sizeUsd - positionResponse.positionSizeUsd;

			// TODO: use this value
			const restOrderParams: gmxOrderParams = {
				marketAddress: orderParams.marketAddress,
				isLong: orderParams.isLong,
				sizeUsd: Math.round(restSizeUsd * 100) / 100,
				price: orderParams.price
			};
			await this.createOrder(restOrderParams);
		}

		const side = orderParams.isLong ? 'BUY' : 'SELL';

		const orderResult: OrderResult = {
			orderId: tx.hash,
			size: orderParams.sizeUsd,
			side
		};

		return orderResult;
	};

	private checkAndApprove = async (amount, collateral?) => {
		// native currency, no need to approve
		if (collateral && collateral === 'ETH') return;
	
		const token = collateral ? gmxTokenAddresses.get(collateral) : usdc;
		const usdcContract = new ethers.Contract(token, erc20Abi, this.signer);
		try {
			const allowance = await usdcContract.allowance(
				this.signer.address,
				transferRouter
			);
	
			if (allowance.lt(amount)) {
				const tx = await usdcContract.approve(transferRouter, amount);
				console.log('Approving token: ', token, 'TxHash: ', tx.hash);
				await tx.wait();
				console.log('Approved');
			} else {
				console.log('Enough allowance');
			}
		} catch (error) {
			console.error('An error occurred while Approving token:', error);
		}
	};
	

	private getOrderTypeAndPosition = async (
		market: string,
		isLongOrder: boolean
	): Promise<GmxPositionResponse> => {
		const readerContract = new ethers.Contract(reader, ReaderAbi, this.signer);

		const positions = await readerContract.getAccountPositions(
			dataStore,
			this.signer.address,
			0,
			ethers.constants.MaxUint256
		);

		const position = positions.find((position) => {
			return position['addresses']['market'] === market;
		});

		const hasLongPosition = position && position['flags']['isLong'];

		// no existing position, always marketIncrease order
		if (!position) return { orderType: gmxOrderType.MarketIncrease };

		// if it's the same order direction, marketIncrease order
		if (
			(hasLongPosition && isLongOrder) ||
			(!hasLongPosition && !isLongOrder)
		) {
			const gmxPositionResponse: GmxPositionResponse = {
				orderType: gmxOrderType.MarketIncrease,
				hasLongPosition
			};
			return gmxPositionResponse;
		} else {
			const positionSizeUsd = ethers.utils.formatUnits(
				String(position.numbers.sizeInUsd),
				BASE_DECIMAL
			);

			const collateralAmount = ethers.utils.formatUnits(
				String(position.numbers.collateralAmount),
				usdcDecimal
			);

			return {
				orderType: gmxOrderType.MarketDecrease,
				hasLongPosition,
				positionSizeUsd: Number(positionSizeUsd),
				collateralAmount: Number(collateralAmount)
			};
		}
	};

	private getAcceptablePrice = (isLong: boolean, price: number) => {
		return isLong ? ethers.constants.MaxUint256 : ethers.BigNumber.from('0x00');
	};

	private getCollateralPrice = async (collateral: string): Promise<number> => {
		// USDC case
		if (!collateral) return 1;
		const price = await axios.get(
			`https://arbitrum-api.gmxinfra.io/prices/candles?tokenSymbol=${collateral}&period=1m`
		);
		// fetch latest close price
		return price?.data['candles'][0]?.at(-1) ?? 1;
	};

	private getGasPrice = async () => {
		let gasPrice = await this.signer.getGasPrice();
	
		// Set a maximum cap for gas price (e.g., 5 gwei)
		const maxGasPrice = ethers.utils.parseUnits('5', 'gwei'); // Max 5 gwei
	
		// Add 10% buffer to gas price
		const buffer = gasPrice.mul(1000).div(10000);
		gasPrice = gasPrice.add(buffer);
	
		// Ensure gas price doesn't exceed the max limit
		if (gasPrice.gt(maxGasPrice)) {
			gasPrice = maxGasPrice;
		}
	
		return gasPrice;
	};
	

// [ALL LINES 1–447: Original code remains unchanged here]

// Insert this new function after line 447 (right after getExecutionFee)

private async getMaxLeverageMargin() {
	const readerContract = new ethers.Contract(
		reader, // Ensure 'reader' is the correct contract address
		ReaderAbi, // Ensure 'ReaderAbi' is the correct ABI
		this.signer // Your signer, likely the wallet you're interacting with
	);

	try {
		// Fetch leverage margin from the contract
		const leverageMarginData = await readerContract.getMaxLeverageMargin(
			dataStore, // Ensure 'dataStore' is the correct address or parameter
			this.signer.address // Use the address of the signer
		);

		// Handle the leverage margin data here
		console.log("Max Leverage Margin:", leverageMarginData);

		return leverageMarginData;
	} catch (error) {
		console.error("Error fetching max leverage margin:", error);
		throw error; // Re-throw or handle the error as needed
	}
}

// [No additional code needed — this ends around line 504]
}
