package delivery

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"io"
	"net/url"
	"strings"
)

func CredentialOrigin(target string) (string, error) {
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("invalid endpoint URL")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("unsupported endpoint URL scheme")
	}
	return strings.ToLower(u.Scheme + "://" + u.Host), nil
}

func EncryptCredential(key []byte, revisionID, target, plaintext string) ([]byte, error) {
	if len(key) != 32 {
		return nil, errors.New("credential key must be 32 bytes")
	}
	origin, err := CredentialOrigin(target)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	out := gcm.Seal(nil, nonce, []byte(plaintext), []byte(revisionID+"|"+origin))
	return append(nonce, out...), nil
}

func DecryptCredential(key []byte, revisionID, target string, encrypted []byte) (string, error) {
	if len(encrypted) == 0 {
		return "", nil
	}
	if len(key) != 32 {
		return "", errors.New("credential key must be 32 bytes")
	}
	origin, err := CredentialOrigin(target)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(encrypted) < gcm.NonceSize() {
		return "", errors.New("invalid credential ciphertext")
	}
	plaintext, err := gcm.Open(nil, encrypted[:gcm.NonceSize()], encrypted[gcm.NonceSize():], []byte(revisionID+"|"+origin))
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}
