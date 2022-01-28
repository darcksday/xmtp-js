import * as proto from '../../src/proto/messaging'
import PrivateKey from './PrivateKey'
import PublicKey from './PublicKey'
import PublicKeyBundle from './PublicKeyBundle'
import Ciphertext from './Ciphertext'
import * as ethers from 'ethers'
import { getRandomValues, hexToBytes } from './utils'
import { decrypt, encrypt } from './encryption'

// PrivateKeyBundle bundles the private keys corresponding to a PublicKeyBundle for convenience.
// This bundle must not be shared with anyone, although will have to be persisted
// somehow so that older messages can be decrypted again.
export default class PrivateKeyBundle implements proto.PrivateKeyBundle {
  identityKey: PrivateKey
  preKeys: PrivateKey[]

  constructor(identityKey: PrivateKey, preKeys?: PrivateKey[]) {
    this.identityKey = identityKey
    this.preKeys = preKeys || []
  }

  // Generate a new key bundle with the preKey signed byt the identityKey.
  // Optionally sign the identityKey with the provided wallet as well.
  static async generate(wallet?: ethers.Signer): Promise<PrivateKeyBundle> {
    const identityKey = PrivateKey.generate()
    if (wallet) {
      identityKey.publicKey.signWithWallet(wallet)
    }
    const bundle = new PrivateKeyBundle(identityKey)
    await bundle.addPreKey()
    return bundle
  }

  // Return the current (latest) pre-key (to be advertised).
  getCurrentPreKey(): PrivateKey {
    return this.preKeys[0]
  }

  // Find pre-key matching the provided public key.
  findPreKey(which: PublicKey): PrivateKey {
    const preKey = this.preKeys.find((key) => key.matches(which))
    if (!preKey) {
      throw new Error('no matching pre-key found')
    }
    return preKey
  }

  // Generate a new pre-key to be used as the current pre-key.
  async addPreKey(): Promise<void> {
    const preKey = PrivateKey.generate()
    await this.identityKey.signKey(preKey.publicKey)
    this.preKeys.unshift(preKey)
  }

  // Return a key bundle with the current pre-key.
  getPublicKeyBundle(): PublicKeyBundle {
    return new PublicKeyBundle(
      this.identityKey.publicKey,
      this.getCurrentPreKey().publicKey
    )
  }

  // sharedSecret derives a secret from peer's key bundles using a variation of X3DH protocol
  // where the sender's ephemeral key pair is replaced by the sender's pre-key.
  // @recipientPreKey is the preKey used to encrypt the message if this is the receiving (decrypting) side.
  async sharedSecret(
    peer: PublicKeyBundle,
    recipientPreKey?: PublicKey
  ): Promise<Uint8Array> {
    if (!peer.identityKey || !peer.preKey) {
      throw new Error('invalid peer key bundle')
    }
    if (!(await peer.identityKey.verifyKey(peer.preKey))) {
      throw new Error('peer preKey signature invalid')
    }
    if (!this.identityKey) {
      throw new Error('missing identity key')
    }
    let dh1: Uint8Array, dh2: Uint8Array, preKey: PrivateKey
    if (recipientPreKey) {
      preKey = this.findPreKey(recipientPreKey)
      dh1 = preKey.sharedSecret(peer.identityKey)
      dh2 = this.identityKey.sharedSecret(peer.preKey)
    } else {
      preKey = this.getCurrentPreKey()
      dh1 = this.identityKey.sharedSecret(peer.preKey)
      dh2 = preKey.sharedSecret(peer.identityKey)
    }
    const dh3 = preKey.sharedSecret(peer.preKey)
    const secret = new Uint8Array(dh1.length + dh2.length + dh3.length)
    secret.set(dh1, 0)
    secret.set(dh2, dh1.length)
    secret.set(dh3, dh1.length + dh2.length)
    return secret
  }

  // encrypts/serializes the bundle for storage
  async encode(wallet: ethers.Signer): Promise<Uint8Array> {
    // serialize the contents
    if (this.preKeys.length === 0) {
      throw new Error('missing pre-keys')
    }
    if (!this.identityKey) {
      throw new Error('missing identity key')
    }
    const bytes = proto.PrivateKeyBundle.encode({
      identityKey: this.identityKey,
      preKeys: this.preKeys,
    }).finish()
    const wPreKey = getRandomValues(new Uint8Array(32))
    const secret = hexToBytes(await wallet.signMessage(wPreKey))
    const ciphertext = await encrypt(bytes, secret)
    return proto.EncryptedPrivateKeyBundle.encode({
      walletPreKey: wPreKey,
      ciphertext,
    }).finish()
  }

  // decrypts/deserializes the bundle from storage bytes
  static async decode(
    wallet: ethers.Signer,
    bytes: Uint8Array
  ): Promise<PrivateKeyBundle> {
    const encrypted = proto.EncryptedPrivateKeyBundle.decode(bytes)
    if (!encrypted.walletPreKey) {
      throw new Error('missing wallet pre-key')
    }
    const secret = hexToBytes(await wallet.signMessage(encrypted.walletPreKey))
    if (!encrypted.ciphertext?.aes256GcmHkdfSha256) {
      throw new Error('missing bundle ciphertext')
    }
    const ciphertext = new Ciphertext(encrypted.ciphertext)
    const decrypted = await decrypt(ciphertext, secret)
    const bundle = proto.PrivateKeyBundle.decode(decrypted)
    if (!bundle.identityKey) {
      throw new Error('missing identity key')
    }
    if (bundle.preKeys.length === 0) {
      throw new Error('missing pre-keys')
    }
    return new PrivateKeyBundle(
      new PrivateKey(bundle.identityKey),
      bundle.preKeys.map((protoKey) => new PrivateKey(protoKey))
    )
  }
}