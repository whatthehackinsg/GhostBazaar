import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ReactNode } from "react"

const MOONPAY_URL = "https://www.moonpay.com"
const STORAGE_KEY = "ghost-bazaar-wallet-state"
const ETHEREUM_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

interface PersistedWalletState {
  readonly address: string | null
  readonly balance: string | null
  readonly isConnected: boolean
}

interface EthereumProvider {
  send: (method: string, params: readonly unknown[]) => Promise<unknown>
}

interface MoonPayWallet {
  readonly network: string
  readonly address: string
}

interface MoonPayLoginResult {
  readonly success?: boolean
}

interface MoonPayAuthSdkInstance {
  init?: () => Promise<void>
  initWalletProvider?: () => Promise<void>
  isLoggedIn?: () => Promise<boolean>
  logout?: () => Promise<boolean> | void
  getWallets?: () => Promise<{ readonly wallets?: readonly MoonPayWallet[] }>
  createWallet?: () => Promise<{ readonly wallets?: readonly MoonPayWallet[] }>
  getProvider?: () => EthereumProvider | null
  login?: {
    show: () => Promise<MoonPayLoginResult | null>
  }
}

interface WalletState {
  readonly address: string | null
  readonly balance: string | null
  readonly isConnected: boolean
  readonly isConnecting: boolean
  readonly error: string | null
  readonly isFallbackMode: boolean
  readonly connect: () => Promise<void>
  readonly disconnect: () => void
  readonly openMoonPay: () => void
}

const defaultValue: WalletState = {
  address: null,
  balance: null,
  isConnected: false,
  isConnecting: false,
  error: null,
  isFallbackMode: false,
  connect: async () => {},
  disconnect: () => {},
  openMoonPay: () => {},
}

const WalletContext = createContext<WalletState>(defaultValue)

function getStoredWalletState(): PersistedWalletState {
  if (typeof window === "undefined") {
    return { address: null, balance: null, isConnected: false }
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { address: null, balance: null, isConnected: false }

    const parsed = JSON.parse(raw) as PersistedWalletState
    return {
      address: parsed.address ?? null,
      balance: parsed.balance ?? null,
      isConnected: parsed.isConnected ?? false,
    }
  } catch {
    return { address: null, balance: null, isConnected: false }
  }
}

function persistWalletState(state: PersistedWalletState) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage failures. Runtime state remains authoritative.
  }
}

function clearStoredWalletState() {
  if (typeof window === "undefined") return

  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatUsdcBalance(balanceHex: string) {
  const raw = BigInt(balanceHex)
  const whole = raw / 1_000_000n
  const fraction = raw % 1_000_000n
  const fractionText = fraction
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "")

  if (!fractionText) return `${whole.toString()}.00 USDC`
  return `${whole.toString()}.${fractionText.slice(0, 2).padEnd(2, "0")} USDC`
}

function encodeBalanceOf(address: string) {
  return `0x70a08231000000000000000000000000${address.toLowerCase().replace(/^0x/, "")}`
}

async function getAccounts(provider: EthereumProvider) {
  const response = await provider.send("eth_accounts", [])
  return Array.isArray(response) ? response.filter((value): value is string => typeof value === "string") : []
}

async function getAddress(
  sdk: MoonPayAuthSdkInstance,
  provider: EthereumProvider | null,
) {
  if (provider) {
    const accounts = await getAccounts(provider)
    if (accounts[0]) return accounts[0]
  }

  const walletResponse = sdk.getWallets
    ? await sdk.getWallets()
    : sdk.createWallet
      ? await sdk.createWallet()
      : null

  if (!walletResponse?.wallets?.length) return null

  const ethereumWallet = walletResponse.wallets.find((wallet) => wallet.network === "ethereum")
  return ethereumWallet?.address ?? walletResponse.wallets[0]?.address ?? null
}

async function getUsdcBalance(
  provider: EthereumProvider | null,
  address: string,
) {
  if (!provider) return "Balance unavailable"

  try {
    const response = await provider.send(
      "eth_call",
      [
        {
          to: ETHEREUM_USDC_ADDRESS,
          data: encodeBalanceOf(address),
        },
        "latest",
      ],
    )

    return typeof response === "string"
      ? formatUsdcBalance(response)
      : "Balance unavailable"
  } catch {
    return "Balance unavailable"
  }
}

async function readWalletSnapshot(sdk: MoonPayAuthSdkInstance) {
  await sdk.initWalletProvider?.()
  const provider = sdk.getProvider?.() ?? null
  const address = await getAddress(sdk, provider)

  if (!address) {
    return {
      address: null,
      balance: null,
      isConnected: false,
    } satisfies PersistedWalletState
  }

  return {
    address,
    balance: await getUsdcBalance(provider, address),
    isConnected: true,
  } satisfies PersistedWalletState
}

async function createMoonPaySdk(apiKey: string) {
  const module = await import("@moonpay/auth-sdk") as unknown as {
    readonly MoonPayAuthSDK: new (
      apiKey: string,
      options?: {
        readonly walletOptions?: {
          readonly generateWallet?: boolean
          readonly isMainnet?: boolean
        }
        readonly components?: readonly unknown[]
      },
    ) => MoonPayAuthSdkInstance
    readonly LoginComponents?: {
      readonly EmailOtp?: unknown
    }
  }
  const MoonPayAuthSDK = module.MoonPayAuthSDK
  const LoginComponents = module.LoginComponents

  return new MoonPayAuthSDK(apiKey, {
    walletOptions: {
      generateWallet: true,
      isMainnet: true,
    },
    components: LoginComponents?.EmailOtp ? [LoginComponents.EmailOtp] : undefined,
  })
}

export function WalletProvider({ children }: { readonly children: ReactNode }) {
  const apiKey = import.meta.env.VITE_MOONPAY_API_KEY as string | undefined
  const initialState = getStoredWalletState()

  const [address, setAddress] = useState<string | null>(initialState.address)
  const [balance, setBalance] = useState<string | null>(initialState.balance)
  const [isConnected, setIsConnected] = useState(initialState.isConnected)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isFallbackMode, setIsFallbackMode] = useState(false)

  const sdkRef = useRef<MoonPayAuthSdkInstance | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    persistWalletState({ address, balance, isConnected })
  }, [address, balance, isConnected])

  useEffect(() => {
    if (!apiKey || initializedRef.current) return

    initializedRef.current = true

    void (async () => {
      try {
        const sdk = await createMoonPaySdk(apiKey)
        sdkRef.current = sdk
        await sdk.init?.()

        const loggedIn = await sdk.isLoggedIn?.()
        if (!loggedIn) return

        const snapshot = await readWalletSnapshot(sdk)
        setAddress(snapshot.address)
        setBalance(snapshot.balance)
        setIsConnected(snapshot.isConnected)
        setError(null)
      } catch {
        sdkRef.current = null
      }
    })()
  }, [apiKey])

  const disconnect = () => {
    sdkRef.current?.logout?.()
    setAddress(null)
    setBalance(null)
    setIsConnected(false)
    setIsConnecting(false)
    setError(null)
    setIsFallbackMode(false)
    clearStoredWalletState()
  }

  const openMoonPay = () => {
    setIsFallbackMode(true)
    window.open(MOONPAY_URL, "_blank", "noopener,noreferrer")
  }

  const connect = async () => {
    if (isConnecting) return

    if (!apiKey) {
      setError("MoonPay key is not configured.")
      openMoonPay()
      return
    }

    setIsConnecting(true)
    setError(null)
    setIsFallbackMode(false)

    try {
      const sdk = sdkRef.current ?? await createMoonPaySdk(apiKey)
      sdkRef.current = sdk
      await sdk.init?.()

      const result = await sdk.login?.show()
      if (!result?.success) return

      const snapshot = await readWalletSnapshot(sdk)
      setAddress(snapshot.address)
      setBalance(snapshot.balance)
      setIsConnected(snapshot.isConnected)

      if (!snapshot.isConnected) {
        setError("MoonPay did not return a wallet connection.")
        openMoonPay()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "MoonPay login failed."
      setError(message)
      console.error("MoonPay connect failed", err)
      openMoonPay()
    } finally {
      setIsConnecting(false)
    }
  }

  const value = useMemo<WalletState>(
    () => ({
      address,
      balance,
      isConnected,
      isConnecting,
      error,
      isFallbackMode,
      connect,
      disconnect,
      openMoonPay,
    }),
    [address, balance, isConnected, isConnecting, error, isFallbackMode],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet() {
  return useContext(WalletContext)
}

export function formatWalletLabel(address: string | null) {
  return address ? truncateAddress(address) : "Wallet unavailable"
}
