"""Shared delivery operation with durable reservations and explicit approval."""

import asyncio
import logging
import uuid

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.store as newsletter_store
import newsletter.types as types

_LOGGER = logging.getLogger(__name__)


async def send_edition(
    store: newsletter_store.Store,
    mail: adapters.MailAdapter,
    request: types.Payload,
    *,
    real_delivery: bool,
    verification: bool = False,
    predecessor: str | None = None,
) -> types.EditionRecord:
    """Send an approved frozen edition at most once for its reservation.

    Unknown provider outcomes remain durable and cannot be blindly retried.
    Verification uses a separate ledger, never resets the daily send guard.

    Args:
        store: Sole owner of the open application database.
        mail: Selected mail provider; never constructed by this operation.
        request: Strict SendEditionRequest ProtoJSON including the exact hash.
        real_delivery: Whether fixture delivery must be rejected.
        verification: Select the explicitly requested verification ledger.
        predecessor: Exact previous verification ID, if extending that chain.

    Returns:
        The current frozen edition and its durable delivery outcome.

    Raises:
        storage.StoreError: Approval conflicts with the frozen edition/ledger.
        contracts.ContractError: The request violates the protobuf contract.
        BaseException: Cancellation/termination, after recording uncertainty.
    """
    with store.deployment.activity("delivery"):
        message = contracts.parse_message(
            request, editorial_pb2.SendEditionRequest
        )
        contracts.validate_request(message)
        value = contracts.to_dict(message)
        edition_id = value["id"]
        if real_delivery and store.get(edition_id)["is_fixture"]:
            raise newsletter_store.StoreError(
                "conflict", "Fixtures cannot be published"
            )
        _validate_predecessor(predecessor, verification)
        if verification:
            edition, first = store.reserve_verification_send(
                value, previous_verification_id=predecessor
            )
        else:
            edition, first = store.reserve_send(value)
        if not first:
            return edition
        try:
            async with asyncio.timeout(35):
                prefix = (
                    "newsletter-verification-"
                    if verification
                    else "newsletter-"
                )
                result = await mail.send(edition, prefix + edition_id)
            return store.finish(edition_id, **result)
        except adapters.AdapterError as error:
            return store.finish(
                edition_id,
                delivery_state="unknown" if error.ambiguous else "rejected",
                error_code=error.code,
            )
        except Exception as error:  # noqa: BLE001 - isolated external write outcome.
            diagnostics.record_failure(
                _LOGGER, phase="delivery", error=error, reference=edition_id
            )
            return store.finish(
                edition_id,
                delivery_state="unknown",
                error_code="delivery_unknown",
            )
        except BaseException:
            store.finish(
                edition_id,
                delivery_state="unknown",
                error_code="delivery_unknown",
            )
            raise


def _validate_predecessor(value: str | None, verification: bool) -> None:
    if value is None:
        return
    if not verification:
        raise newsletter_store.StoreError(
            "invalid_argument", "Predecessor is only valid for verification"
        )
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError
    except ValueError:
        raise newsletter_store.StoreError(
            "invalid_argument",
            "Verification predecessor must be a canonical UUID",
        ) from None
