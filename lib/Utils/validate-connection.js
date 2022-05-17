"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureSuccessfulPairing = exports.generateRegistrationNode = exports.generateLoginNode = void 0;
const boom_1 = require("@hapi/boom");
const crypto_1 = require("crypto");
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const WABinary_1 = require("../WABinary");
const crypto_2 = require("./crypto");
const generics_1 = require("./generics");
const signal_1 = require("./signal");
const getUserAgent = ({ version }) => {
    const osVersion = '0.1';
    return {
        appVersion: {
            primary: version[0],
            secondary: version[1],
            tertiary: version[2],
        },
        platform: WAProto_1.proto.UserAgent.UserAgentPlatform.WEB,
        releaseChannel: WAProto_1.proto.UserAgent.UserAgentReleaseChannel.RELEASE,
        mcc: '000',
        mnc: '000',
        osVersion: osVersion,
        manufacturer: '',
        device: 'Desktop',
        osBuildNumber: osVersion,
        localeLanguageIso6391: 'en',
        localeCountryIso31661Alpha2: 'US',
    };
};
const getWebInfo = () => ({
    webSubPlatform: WAProto_1.proto.WebInfo.WebInfoWebSubPlatform.WEB_BROWSER
});
const getClientPayload = (config) => {
    return {
        connectType: WAProto_1.proto.ClientPayload.ClientPayloadConnectType.WIFI_UNKNOWN,
        connectReason: WAProto_1.proto.ClientPayload.ClientPayloadConnectReason.USER_ACTIVATED,
        userAgent: getUserAgent(config),
        webInfo: getWebInfo(),
    };
};
const generateLoginNode = (userJid, config) => {
    const { user, device } = WABinary_1.jidDecode(userJid);
    const payload = {
        ...getClientPayload(config),
        passive: true,
        username: +user,
        device: device,
    };
    return WAProto_1.proto.ClientPayload.fromObject(payload);
};
exports.generateLoginNode = generateLoginNode;
const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config) => {
    // the app version needs to be md5 hashed
    // and passed in
    const appVersionBuf = crypto_1.createHash('md5')
        .update(config.version.join('.')) // join as string
        .digest();
    const browserVersion = config.browser[2].split('.');
    const companion = {
        os: config.browser[0],
        version: {
            primary: +(browserVersion[0] || 0),
            secondary: +(browserVersion[1] || 1),
            tertiary: +(browserVersion[2] || 0),
        },
        platformType: WAProto_1.proto.CompanionProps.CompanionPropsPlatformType[config.browser[1].toUpperCase()] || WAProto_1.proto.CompanionProps.CompanionPropsPlatformType.UNKNOWN,
        requireFullSync: false,
    };
    const companionProto = WAProto_1.proto.CompanionProps.encode(companion).finish();
    const registerPayload = {
        ...getClientPayload(config),
        passive: false,
        regData: {
            buildHash: appVersionBuf,
            companionProps: companionProto,
            eRegid: generics_1.encodeBigEndian(registrationId),
            eKeytype: Defaults_1.KEY_BUNDLE_TYPE,
            eIdent: signedIdentityKey.public,
            eSkeyId: generics_1.encodeBigEndian(signedPreKey.keyId, 3),
            eSkeyVal: signedPreKey.keyPair.public,
            eSkeySig: signedPreKey.signature,
        },
    };
    return WAProto_1.proto.ClientPayload.fromObject(registerPayload);
};
exports.generateRegistrationNode = generateRegistrationNode;
const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
    const msgId = stanza.attrs.id;
    const pairSuccessNode = WABinary_1.getBinaryNodeChild(stanza, 'pair-success');
    const deviceIdentityNode = WABinary_1.getBinaryNodeChild(pairSuccessNode, 'device-identity');
    const platformNode = WABinary_1.getBinaryNodeChild(pairSuccessNode, 'platform');
    const deviceNode = WABinary_1.getBinaryNodeChild(pairSuccessNode, 'device');
    const businessNode = WABinary_1.getBinaryNodeChild(pairSuccessNode, 'biz');
    if (!deviceIdentityNode || !deviceNode) {
        throw new boom_1.Boom('Missing device-identity or device in pair success node', { data: stanza });
    }
    const bizName = businessNode === null || businessNode === void 0 ? void 0 : businessNode.attrs.name;
    const jid = deviceNode.attrs.jid;
    const { details, hmac } = WAProto_1.proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content);
    // check HMAC matches
    const advSign = crypto_2.hmacSign(details, Buffer.from(advSecretKey, 'base64'));
    if (Buffer.compare(hmac, advSign) !== 0) {
        throw new boom_1.Boom('Invalid account signature');
    }
    const account = WAProto_1.proto.ADVSignedDeviceIdentity.decode(details);
    const { accountSignatureKey, accountSignature, details: deviceDetails } = account;
    // verify the device signature matches
    const accountMsg = Buffer.concat([Buffer.from([6, 0]), deviceDetails, signedIdentityKey.public]);
    if (!crypto_2.Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
        throw new boom_1.Boom('Failed to verify account signature');
    }
    // sign the details with our identity key
    const deviceMsg = Buffer.concat([Buffer.from([6, 1]), deviceDetails, signedIdentityKey.public, accountSignatureKey]);
    account.deviceSignature = crypto_2.Curve.sign(signedIdentityKey.private, deviceMsg);
    // do not provide the "accountSignatureKey" back
    account.accountSignatureKey = null;
    const identity = signal_1.createSignalIdentity(jid, accountSignatureKey);
    const accountEnc = WAProto_1.proto.ADVSignedDeviceIdentity.encode(account).finish();
    const deviceIdentity = WAProto_1.proto.ADVDeviceIdentity.decode(account.details);
    const reply = {
        tag: 'iq',
        attrs: {
            to: WABinary_1.S_WHATSAPP_NET,
            type: 'result',
            id: msgId,
        },
        content: [
            {
                tag: 'pair-device-sign',
                attrs: {},
                content: [
                    {
                        tag: 'device-identity',
                        attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
                        content: accountEnc
                    }
                ]
            }
        ]
    };
    const authUpdate = {
        account,
        me: { id: jid, name: bizName },
        signalIdentities: [
            ...(signalIdentities || []),
            identity
        ],
        platform: platformNode === null || platformNode === void 0 ? void 0 : platformNode.attrs.name
    };
    return {
        creds: authUpdate,
        reply
    };
};
exports.configureSuccessfulPairing = configureSuccessfulPairing;